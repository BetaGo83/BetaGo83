#!/usr/bin/env python3
"""기사 본문을 읽으려면 클라우드 환경에서 허용해야 하는 언론사 도메인 목록을 만든다.

위키가 출처로 단 기사의 언론사를 먼저 넣고, 테마 검색어와 위키 기업 이름으로 구글 뉴스 RSS(최근 30일)를 검색해
자주 나오는 언론사(<source url="...">)를 더해 언론사 도메인이 --max-domains개(기본 60개)가 될 때까지 채운다.
결과는 docs/allowed-domains.txt에 한 줄에 하나씩 쓴다. 클라우드 환경 설정의 Network access를 Custom으로
바꾸고 Allowed domains 칸에 그대로 붙여 넣은 뒤 "Also include default list"를 체크하면 된다.
목록이 너무 길면 환경 설정이 저장되지 않는다(2026-10-03: 550줄은 실패, 77줄은 저장됨). 그래서 개수를 제한한다.
목록에 없는 언론사는 scripts/fetch_articles.py가 '접속이 막힌 사이트'로 알려 주니 그때 몇 개씩 더한다.
블로그·영상·광고성 사이트(SKIP)는 넣지 않는다. 기사 본문은 신뢰할 수 없는 외부 글이라 허용 범위를 좁게 둔다.

    python3 scripts/list_news_domains.py
    python3 scripts/list_news_domains.py --max-domains 80
"""

import argparse
import collections
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

from collect_news import SPAM, SPAM_OUTLETS, fetch
from fetch_articles import google_article_url, load_cached
from wiki_common import ROOT, SKIP, WIKI, pages, read_jsonl, registrable

OUTPUT = ROOT / "docs" / "allowed-domains.txt"
# 본문 읽기와 링크 풀기에 필요한 포털·검색 도메인 (언론사 목록과 별도로 항상 넣는다)
ALWAYS = [
    "news.google.com",      # 구글 뉴스 RSS (이미 허용)
    "www.google.com",       # 구글 뉴스가 다른 구글 주소로 넘겨 보낼 때 대비
    "openapi.naver.com",    # 네이버 검색 API (이미 허용)
    "n.news.naver.com",     # 네이버 뉴스 본문 (블로그·카페는 넣지 않는다)
    "news.naver.com",
    "m.news.naver.com",
    "v.daum.net",           # 다음 뉴스 본문
    "news.nate.com",        # 네이트 뉴스 본문 (커뮤니티는 넣지 않는다)
    "m.news.nate.com",
    "news.zum.com",         # 줌 뉴스 본문
    "opendart.fss.or.kr",   # DART API (이미 허용)
    "dart.fss.or.kr",       # DART 공시 뷰어
    "betago83.github.io",   # 이 위키의 공개 웹사이트 (배포 확인용)
]


def outlets(query):
    q = urllib.parse.quote(f"{query} when:30d")
    root = ET.fromstring(fetch(f"https://news.google.com/rss/search?q={q}&hl=ko&gl=KR&ceid=KR:ko"))
    for item in root.iter("item"):
        source = item.find("source")
        if SPAM.search(item.findtext("title") or "") or (source is not None and source.text in SPAM_OUTLETS):
            continue
        if source is not None and source.get("url"):
            host = urllib.parse.urlparse(source.get("url")).hostname
            if host:
                yield host, source.text or ""


def cited_rows():
    """위키가 출처로 단 기사들 (raw/news에서 주소로 찾는다)."""
    cited = set()
    for path in WIKI.rglob("*.md"):
        cited.update(re.findall(r"\]\((https?://[^)\s]+)\)", path.read_text(encoding="utf-8")))
    return [row for row in read_jsonl("news") if row["url"] in cited]


def cited_domains():
    """위키가 인용한 기사의 (언론사 도메인 수, 하위 주소 없이 쓰는 도메인).
    언론사 주소(outlet_url)가 없는 옛 기사는 구글 뉴스 링크를 풀어 원래 기사 주소에서 찾는다."""
    found, apex = collections.Counter(), set()
    for row in cited_rows():
        host = urllib.parse.urlparse(row.get("outlet_url", "")).hostname
        cached = load_cached(row["url"]) or {}
        if not host and cached.get("article_url"):  # fetch_articles.py가 풀어 둔 원래 기사 주소
            host = urllib.parse.urlparse(cached["article_url"]).hostname
        if not host:
            try:
                host = urllib.parse.urlparse(google_article_url(row["url"])).hostname
            except Exception as error:  # 한 기사가 실패해도 계속
                print(f"[실패] {row['title']}: {error}", file=sys.stderr)
            time.sleep(1)
        if host:
            found[registrable(host)] += 1
            if host.lower().strip(".") == registrable(host):
                apex.add(registrable(host))
        else:
            print(f"[못 찾음] {row['outlet']}: {row['title']}", file=sys.stderr)
    return found, apex


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-domains", type=int, default=60, help="언론사 도메인 수 (위키가 인용한 언론사는 이보다 많아도 다 넣는다)")
    args = parser.parse_args()

    queries = []
    for _, _, meta, _ in pages("themes"):
        queries += meta.get("keywords", [])
    for name, _, meta, _ in pages("companies"):
        queries.append(name)
    queries = list(dict.fromkeys(queries))
    cited, cited_apex = cited_domains()

    counts, names, apex = collections.Counter(), {}, set(cited_apex)
    for row in read_jsonl("news"):  # 수집할 때 저장한 언론사 주소
        host = urllib.parse.urlparse(row.get("outlet_url", "")).hostname
        if host:
            counts[registrable(host)] += 1
            names.setdefault(registrable(host), row["outlet"])
            if host.lower().strip(".") == registrable(host):
                apex.add(registrable(host))
    for number, query in enumerate(queries, 1):
        try:
            for host, outlet in outlets(query):
                domain = registrable(host)
                counts[domain] += 1
                if host.lower().strip(".") == domain:
                    apex.add(domain)  # 하위 주소 없이 쓰는 언론사
                names.setdefault(domain, outlet)
        except Exception as error:  # 한 검색어가 실패해도 계속
            print(f"[실패] {query}: {error}", file=sys.stderr)
        if number % 10 == 0:
            print(f"{number}/{len(queries)} 검색, 도메인 {len(counts)}개", file=sys.stderr)
        time.sleep(1)

    chosen = [domain for domain, _ in cited.most_common() if domain not in SKIP]  # 위키가 인용한 언론사는 빠짐없이
    for domain, _ in counts.most_common():
        if len(chosen) >= args.max_domains:
            break
        if domain not in SKIP and domain not in chosen:
            chosen.append(domain)
    lines = list(ALWAYS)
    for domain in chosen:
        # '*.도메인'은 하위 주소(www., news. 등)만 허용하므로, 하위 주소 없이 쓰는 곳은 원래 주소도 넣는다
        for entry in ([domain] if domain in apex else []) + [f"*.{domain}"]:
            if entry not in lines:
                lines.append(entry)
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")

    report = ROOT / "raw" / ".cache" / "news-domains.tsv"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        "".join(f"{count}\t{domain}\t{names[domain]}\n" for domain, count in counts.most_common()),
        encoding="utf-8",
    )
    print(f"검색어 {len(queries)}개, 찾은 언론사 도메인 {len(counts)}개 중 {len(chosen)}개 "
          f"(위키 인용 {len(cited)}개 포함) -> docs/allowed-domains.txt ({len(lines)}줄)")


if __name__ == "__main__":
    main()
