"""스크립트들이 같이 쓰는 도구: 위키 페이지 읽기, 원자료 파일 읽고 쓰기, 키 가리기."""

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIKI = ROOT / "wiki"
RAW = ROOT / "raw"

KST = timezone(timedelta(hours=9))


def today_kst():
    """한국 시간 기준 오늘 날짜. 공시·기사 날짜가 한국 시간이라 이걸 기준으로 쓴다."""
    return datetime.now(KST).date()


FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
LIST_KEYS = ("aliases", "themes", "keywords", "stages", "tags")
ITEM = re.compile(r"""\s*(?:"([^"]*)"|'([^']*)'|([^,]*?))\s*(?:,|$)""")


def parse_value(text):
    text = text.split(" #", 1)[0].strip()
    if text.startswith("[") and text.endswith("]"):
        # 따옴표 안의 쉼표는 나누지 않는다
        inner = text[1:-1]
        items, pos = [], 0
        while pos < len(inner):
            m = ITEM.match(inner, pos)
            items.append(next((g for g in m.groups() if g is not None), "").strip())
            pos = m.end() if m.end() > pos else pos + 1
        return [item for item in items if item]
    return text.strip("\"'")


def read_page(path):
    """(frontmatter dict, 본문) 을 돌려준다.

    'key: value', 'key: [a, b]', 그리고 옵시디언이 바꿔 쓰는 블록 목록('key:' 다음 줄의 '  - a')을 읽는다.
    목록이어야 하는 키(aliases, themes, keywords, stages)는 값이 하나여도 목록으로 돌려준다.
    """
    text = Path(path).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    meta = {}
    match = FRONTMATTER.match(text)
    if match:
        key = None
        for line in match.group(1).splitlines():
            item = re.match(r"^\s+-\s+(.*)$", line)
            if item and key and isinstance(meta.get(key), list):
                meta[key].append(item.group(1).strip().strip("\"'"))
            elif ":" in line and not line.startswith((" ", "\t")):
                key, value = line.split(":", 1)
                key = key.strip()
                meta[key] = parse_value(value) if value.strip() else []
        for key in LIST_KEYS:
            if key in meta and not isinstance(meta[key], list):
                meta[key] = [meta[key]] if meta[key] else []
        for key, value in meta.items():
            if value == [] and key not in LIST_KEYS:
                meta[key] = ""
        text = text[match.end():]
    return meta, text


def is_folder_index(path):
    """wiki/companies/index.md처럼 폴더 안내용 페이지인지 (기업·테마 페이지가 아니다)."""
    return Path(path).stem == "index" and Path(path).parent != WIKI


def pages(kind):
    """kind: 'companies' 또는 'themes'. (페이지 이름, 경로, meta, 본문) 목록. 폴더 안내 페이지는 뺀다."""
    result = []
    for path in sorted((WIKI / kind).glob("*.md")):
        if is_folder_index(path):
            continue
        meta, body = read_page(path)
        result.append((path.stem, path, meta, body))
    return result


def read_jsonl(folder):
    rows = []
    for path in sorted((RAW / folder).glob("*.jsonl")):
        with open(path, encoding="utf-8") as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    return rows


def append_jsonl(folder, date, rows):
    path = RAW / folder / f"{date}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


# 2단계 국가 도메인: mt.co.kr처럼 끝 세 칸이 한 사이트다 (hankyung.com은 끝 두 칸)
SECOND_LEVEL = {"co", "or", "go", "ne", "re", "ac", "com", "net", "org", "pe", "kg", "es", "hs", "ms", "sc"}


def registrable(host):
    """news.mt.co.kr -> mt.co.kr, biz.chosun.com -> chosun.com"""
    labels = host.lower().strip(".").split(".")
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


# 뉴스가 아닌 곳: 포털(list_news_domains.ALWAYS에서 뉴스 주소만 따로 허용), 블로그·영상·SNS, 시장조사·투자의견 사이트, 스팸
SKIP = {
    "naver.com", "daum.net", "google.com", "youtu.be", "youtube.com", "fb.com", "facebook.com", "meta.com",
    "instagram.com", "x.com", "twitter.com", "weverse.io", "tistory.com", "brunch.co.kr", "note.com",
    "blogspot.com", "medium.com", "actt.org.tt", "mlbkor.com", "calgaryroughnecks.com", "dto.ooo", "seattlen.com",
    "indexbox.io", "fortunebusinessinsights.com", "businessresearchinsights.com", "straitsresearch.com",
    "simplywall.st", "tikr.com", "thinkpool.com", "pressreader.com", "deloitte.com",
    "histoire-pour-tous.fr", "nate.com", "zum.com", "danawa.com", "choicestock.co.kr", "buffettlab.co.kr",
    "tradingview.com", "tradingkey.com", "metal.com", "ecofile.kr",
}


def hide_secrets(text):
    """오류 메시지에 키가 섞이지 않도록 가린다."""
    text = str(text)
    for name in ("DART_API_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"):
        value = os.environ.get(name, "").strip()
        if value:
            text = text.replace(value, "***")
    return re.sub(r"crtfc_key=[^&\s]+", "crtfc_key=***", text)
