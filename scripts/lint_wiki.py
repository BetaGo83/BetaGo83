#!/usr/bin/env python3
"""위키를 점검한다: 깨진 링크, 출처 없는 줄, 짝이 맞지 않는 관계, 고아 페이지,
1년 넘은 관계, 빠진 항목(frontmatter, 면책 문구).

문제가 있으면 목록을 출력하고 종료 코드 1로 끝난다.

    python3 scripts/lint_wiki.py
"""

import re
import sys
from datetime import date, timedelta

from build_graph import LINK, relations, section
from wiki_common import WIKI, read_page

DISCLAIMER = "AI가 뉴스와 공시를 바탕으로 정리한 참고 자료입니다. 틀린 내용이 있을 수 있으니 원문을 확인하세요. 투자 권유가 아닙니다."
PAIRS = {
    "공급사": "고객사", "고객사": "공급사", "출자": "피출자", "피출자": "출자",
    "인수": "피인수", "피인수": "인수", "계열": "계열", "협력": "협력", "경쟁": "경쟁",
}
ISSUE_KINDS = {"계약", "수주", "투자", "인수합병", "협력", "실적", "정책", "기타"}
SOURCED_SECTIONS = ("사업 개요", "테마", "최근 이슈", "테마 설명", "최근 동향")
REQUIRED = {
    "company": ("type", "name", "market", "themes", "updated"),
    "theme": ("type", "name", "keywords", "updated"),
}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def main():
    files = sorted(WIKI.rglob("*.md"))
    names = {path.stem: path for path in files}
    problems = []
    inbound = {name: 0 for name in names}
    loaded = {}

    for path in files:
        meta, body = read_page(path)
        loaded[path.stem] = (path, meta, body)
        rel = path.relative_to(WIKI)
        for target in LINK.findall(body):
            target = target.strip()
            if target not in names:
                problems.append(f"{rel}: 깨진 링크 [[{target}]]")
            elif target != path.stem:
                inbound[target] += 1

        kind = meta.get("type")
        if kind in REQUIRED:
            for key in REQUIRED[kind]:
                if not meta.get(key):
                    problems.append(f"{rel}: frontmatter에 {key}가 없습니다")
            if DISCLAIMER not in body:
                problems.append(f"{rel}: 면책 문구가 없습니다")
            if "## 사람 메모" not in body:
                problems.append(f"{rel}: '## 사람 메모' 칸이 없습니다")
            for theme in meta.get("themes", []) if kind == "company" else []:
                if theme not in names:
                    problems.append(f"{rel}: themes의 '{theme}' 페이지가 없습니다")

        for title in SOURCED_SECTIONS if kind in REQUIRED else ():
            for line in section(body, title).splitlines():
                if line.startswith("- ") and "http" not in line:
                    problems.append(f"{rel}: 출처 없는 줄 ({title}) {line[:50]}")
        for line in section(body, "최근 이슈").splitlines():
            match = re.match(r"^- (\S+) \[([^\]]+)\]", line)
            if line.startswith("- ") and not (match and DATE.match(match.group(1)) and match.group(2) in ISSUE_KINDS):
                problems.append(f"{rel}: 이슈 형식이 틀립니다 (- YYYY-MM-DD [종류] ...) {line[:50]}")

    year_ago = date.today() - timedelta(days=365)
    for name, (path, meta, body) in loaded.items():
        if meta.get("type") != "company":
            continue
        rel = path.relative_to(WIKI)
        for row in relations(body):
            if row["type"] not in PAIRS:
                problems.append(f"{rel}: 모르는 관계 종류 '{row['type']}'")
                continue
            if not row["source"]:
                problems.append(f"{rel}: 출처 없는 관계 {row['type']} {row['target']}")
            if not DATE.match(row["date"]):
                problems.append(f"{rel}: 관계 날짜 형식이 틀립니다 {row['target']} '{row['date']}'")
            elif date.fromisoformat(row["date"]) < year_ago:
                problems.append(f"{rel}: 1년 넘게 갱신되지 않은 관계 {row['type']} {row['target']} ({row['date']})")
            if not row["linked"] or row["target"] not in loaded:
                continue
            partner = relations(loaded[row["target"]][2])
            if not any(p["target"] == name and p["type"] == PAIRS[row["type"]] for p in partner):
                problems.append(f"{rel}: 짝이 없는 관계 — [[{row['target']}]]에 '{PAIRS[row['type']]} [[{name}]]' 줄이 필요합니다")

    for name, count in inbound.items():
        meta = loaded[name][1]
        if count == 0 and meta.get("type") in ("company", "theme"):
            problems.append(f"{loaded[name][0].relative_to(WIKI)}: 고아 페이지 (들어오는 링크 없음)")

    for problem in problems:
        print(problem)
    print(f"점검 끝: 페이지 {len(files)}개, 문제 {len(problems)}개")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
