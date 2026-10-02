#!/usr/bin/env python3
"""테마 검색어로 뉴스 메타데이터(제목, 링크, 언론사, 날짜)를 모아 raw/news/오늘.jsonl에 더한다.

검색어는 wiki/themes/*.md의 keywords에서 읽는다. 구글 뉴스 RSS를 쓰고,
NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET이 있으면 네이버 뉴스 검색도 쓴다.
이미 모은 기사(같은 URL 또는 같은 제목)는 건너뛴다. 기사 본문은 저장하지 않는다.

    python3 scripts/collect_news.py            # 최근 3일
    python3 scripts/collect_news.py --days 7
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from wiki_common import append_jsonl, hide_secrets, pages, read_jsonl

KST = timezone(timedelta(hours=9))
TAG = re.compile(r"<[^>]+>")
# 검색 결과에 섞여 들어오는 도박·성인 스팸
SPAM = re.compile(r"카지노|토토사이트|스포츠토토|포커|바카라|슬롯머신|슬롯사이트|섹스|성인용|성인사이트|베팅|배팅|먹튀|홀덤|도박|룰렛|파워볼")
SPAM_OUTLETS = {"Calgary Roughnecks", "dto.ooo", "Histoire"}


def fetch(url, headers=None):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **(headers or {})})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def google_news(query, days):
    q = urllib.parse.quote(f"{query} when:{days}d")
    root = ET.fromstring(fetch(f"https://news.google.com/rss/search?q={q}&hl=ko&gl=KR&ceid=KR:ko"))
    for item in root.iter("item"):
        source = item.find("source")
        outlet = item.findtext("source") or ""
        title = item.findtext("title") or ""
        if outlet and title.endswith(f" - {outlet}"):
            title = title[: -len(outlet) - 3]
        yield {
            "title": title.strip(),
            "url": item.findtext("link"),
            "outlet": outlet,
            "outlet_url": source.get("url", "") if source is not None else "",  # 언론사 주소 (접속 허용 목록용)
            "published_at": parsedate_to_datetime(item.findtext("pubDate")).astimezone(KST).isoformat(),
        }


def naver_news(query):
    client_id = os.environ.get("NAVER_CLIENT_ID", "").strip()
    secret = os.environ.get("NAVER_CLIENT_SECRET", "").strip()
    if not (client_id and secret):
        return
    q = urllib.parse.quote(query)
    data = json.loads(fetch(
        f"https://openapi.naver.com/v1/search/news.json?query={q}&display=100&sort=date",
        {"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": secret},
    ))
    for item in data.get("items", []):
        link = item.get("originallink") or item["link"]
        yield {
            "title": html.unescape(TAG.sub("", item["title"])).strip(),
            "url": link,
            "outlet": urllib.parse.urlparse(link).netloc,
            "outlet_url": f"https://{urllib.parse.urlparse(link).netloc}",
            "published_at": parsedate_to_datetime(item["pubDate"]).astimezone(KST).isoformat(),
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3)
    args = parser.parse_args()

    seen_urls, seen_titles = set(), set()
    for row in read_jsonl("news"):
        seen_urls.add(row["url"])
        seen_titles.add(row["title"])

    since = datetime.now(KST) - timedelta(days=args.days)
    new_rows, errors = [], 0
    for theme, _, meta, _ in pages("themes"):
        for query in meta.get("keywords", []):
            for source in (lambda: google_news(query, args.days), lambda: naver_news(query)):
                try:
                    items = list(source() or [])
                except Exception as error:  # 한 검색어가 실패해도 나머지는 계속
                    errors += 1
                    print(f"[실패] {theme} / {query}: {hide_secrets(error)}", file=sys.stderr)
                    continue
                for item in items:
                    if not item["url"] or item["url"] in seen_urls or item["title"] in seen_titles:
                        continue
                    if item["outlet"] in SPAM_OUTLETS or SPAM.search(item["title"]):
                        continue
                    if datetime.fromisoformat(item["published_at"]) < since:
                        continue
                    seen_urls.add(item["url"])
                    seen_titles.add(item["title"])
                    new_rows.append({**item, "theme": theme, "query": query})

    new_rows.sort(key=lambda row: row["published_at"])
    today = datetime.now(KST).strftime("%Y-%m-%d")
    if new_rows:
        path = append_jsonl("news", today, new_rows)
        print(f"새 기사 {len(new_rows)}건 -> {path.relative_to(path.parents[2])}")
    else:
        print("새 기사 없음")
    if errors:
        print(f"실패한 검색 {errors}건", file=sys.stderr)


if __name__ == "__main__":
    main()
