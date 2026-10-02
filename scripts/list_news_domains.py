#!/usr/bin/env python3
"""기사 본문을 읽으려면 클라우드 환경에서 허용해야 하는 언론사 도메인 목록을 만든다.

테마 검색어와 위키 기업 이름으로 구글 뉴스 RSS(최근 30일)를 검색해, 각 기사에 붙은 언론사 주소
(<source url="...">)를 모은다. 결과는 docs/allowed-domains.txt에 한 줄에 하나씩 쓴다.
클라우드 환경 설정의 Network access를 Custom으로 바꾸고 Allowed domains 칸에 그대로 붙여 넣으면 된다.

    python3 scripts/list_news_domains.py
"""

import collections
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

from collect_news import SPAM, SPAM_OUTLETS, fetch
from wiki_common import ROOT, pages

OUTPUT = ROOT / "docs" / "allowed-domains.txt"
# 2단계 국가 도메인 (예: hankyung.co.kr이 아니라 hankyung.com, mt.co.kr처럼 끝 세 칸을 남기는 경우)
SECOND_LEVEL = {"co", "or", "go", "ne", "re", "ac", "com", "net", "org", "pe", "kg", "es", "hs", "ms", "sc"}
# 본문 읽기와 링크 풀기에 필요한 포털·검색 도메인 (언론사 목록과 별도로 항상 넣는다)
ALWAYS = [
    "news.google.com",      # 구글 뉴스 RSS (이미 허용)
    "www.google.com",       # 구글 뉴스 링크를 실제 기사 주소로 풀 때 거치는 주소
    "openapi.naver.com",    # 네이버 검색 API (이미 허용)
    "*.naver.com",          # 네이버 뉴스 본문 (n.news.naver.com)
    "*.daum.net",           # 다음 뉴스 본문 (v.daum.net)
    "opendart.fss.or.kr",   # DART API (이미 허용)
    "dart.fss.or.kr",       # DART 공시 뷰어
]


def registrable(host):
    labels = host.lower().strip(".").split(".")
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


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


def main():
    queries = []
    for _, _, meta, _ in pages("themes"):
        queries += meta.get("keywords", [])
    for name, _, meta, _ in pages("companies"):
        queries.append(name)
    queries = list(dict.fromkeys(queries))

    counts, names, apex = collections.Counter(), {}, set()
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

    lines = list(ALWAYS)
    for domain, _ in counts.most_common():
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
    print(f"검색어 {len(queries)}개, 언론사 도메인 {len(counts)}개 -> docs/allowed-domains.txt ({len(lines)}줄)")


if __name__ == "__main__":
    main()
