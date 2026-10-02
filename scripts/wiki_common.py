"""스크립트들이 같이 쓰는 도구: 위키 페이지 읽기, 원자료 파일 읽고 쓰기, 키 가리기."""

import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIKI = ROOT / "wiki"
RAW = ROOT / "raw"

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def parse_value(text):
    text = text.split(" #", 1)[0].strip()
    if text.startswith("[") and text.endswith("]"):
        return [item.strip().strip("\"'") for item in text[1:-1].split(",") if item.strip()]
    return text.strip("\"'")


def read_page(path):
    """(frontmatter dict, 본문) 을 돌려준다. 단순한 'key: value' 형식만 읽는다."""
    text = Path(path).read_text(encoding="utf-8")
    meta = {}
    match = FRONTMATTER.match(text)
    if match:
        for line in match.group(1).splitlines():
            if ":" in line and not line.startswith(" "):
                key, value = line.split(":", 1)
                meta[key.strip()] = parse_value(value)
        text = text[match.end():]
    return meta, text


def pages(kind):
    """kind: 'companies' 또는 'themes'. (페이지 이름, 경로, meta, 본문) 목록."""
    result = []
    for path in sorted((WIKI / kind).glob("*.md")):
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


def hide_secrets(text):
    """오류 메시지에 키가 섞이지 않도록 가린다."""
    text = str(text)
    for name in ("DART_API_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"):
        value = os.environ.get(name, "").strip()
        if value:
            text = text.replace(value, "***")
    return re.sub(r"crtfc_key=[^&\s]+", "crtfc_key=***", text)
