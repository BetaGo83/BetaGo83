#!/usr/bin/env python3
"""위키를 점검한다.

- 깨진 링크, 출처 없는 줄, 이슈 형식, 빠진 항목(frontmatter, 면책 문구, 사람 메모 칸)
- 짝이 맞지 않는 관계, 1년 넘게 갱신되지 않은 관계, 모르는 관계 종류
- 고아 페이지(들어오는 링크 없음)
- 밸류체인 단계: 테마 페이지의 stages·밸류체인과 기업 페이지 테마 줄의 단계가 서로 맞는지
- 기업 frontmatter themes와 '## 테마' 줄이 맞는지, 이슈마다 [[테마]] 링크가 있는지
- 같은 별칭·DART 고유번호·종목코드를 두 페이지가 쓰는지
- 페이지 없이 두 번 이상 나온 상대 회사 (페이지를 만들 차례)
- wiki/graph.json과 테마 표가 최신인지 (build_graph.py를 다시 돌렸는지)

문제가 있으면 목록을 출력하고 종료 코드 1로 끝난다.

    python3 scripts/lint_wiki.py
"""

import collections
import json
import re
import sys
from datetime import date, timedelta

from build_graph import ISSUE, LINK, build, relations, section, theme_roles, valid_date, value_chain
from wiki_common import WIKI, is_folder_index, read_page, today_kst

DISCLAIMER = "AI가 뉴스와 공시를 바탕으로 정리한 참고 자료입니다. 틀린 내용이 있을 수 있으니 원문을 확인하세요. 투자 권유가 아닙니다."
PAIRS = {
    "공급사": "고객사", "고객사": "공급사", "출자": "피출자", "피출자": "출자",
    "인수": "피인수", "피인수": "인수", "계열": "계열", "협력": "협력", "경쟁": "경쟁",
}
ISSUE_KINDS = {"계약", "수주", "투자", "인수합병", "협력", "실적", "정책", "기타"}
MARKETS = {"KOSPI", "KOSDAQ", "KONEX", "비상장", "해외"}
SOURCED_SECTIONS = ("사업 개요", "테마", "최근 이슈", "테마 설명", "밸류체인", "최근 동향")
REQUIRED = {
    "company": ("type", "name", "market", "themes", "updated"),
    "theme": ("type", "name", "keywords", "stages", "updated"),
}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FOLDER_KIND = {"companies": "company", "themes": "theme"}
COUNTERPARTY_PAGE_AT = 2  # 페이지 없는 상대가 이만큼 나오면 페이지를 만든다


def check_pages(files, names, loaded, problems):
    inbound = {name: 0 for name in names}
    theme_names = {p.stem for p in files if p.parent.name == "themes" and not is_folder_index(p)}
    for path in files:
        meta, body = read_page(path)
        if not is_folder_index(path):
            loaded[path.stem] = (path, meta, body)
        rel = path.relative_to(WIKI)
        for target in LINK.findall(body):
            target = target.strip()
            if target not in names:
                problems.append(f"{rel}: 깨진 링크 [[{target}]]")
            elif target != path.stem:
                inbound[target] += 1

        if DISCLAIMER not in body:
            problems.append(f"{rel}: 면책 문구가 없습니다")
        kind = meta.get("type")
        expected = FOLDER_KIND.get(path.parent.name) if path.parent != WIKI and not is_folder_index(path) else None
        if expected and kind != expected:
            problems.append(f"{rel}: frontmatter type이 '{expected}'여야 합니다 (frontmatter를 읽지 못했거나 type이 틀림)")
            kind = expected
        if kind not in REQUIRED:
            continue
        for key in REQUIRED[kind]:
            if not meta.get(key):
                problems.append(f"{rel}: frontmatter에 {key}가 없습니다")
        if meta.get("name") and meta["name"] != path.stem:
            problems.append(f"{rel}: frontmatter name '{meta['name']}'이 파일 이름과 다릅니다")
        if meta.get("updated") and not (DATE.match(meta["updated"]) and valid_date(meta["updated"])):
            problems.append(f"{rel}: updated 날짜 형식이 틀립니다 '{meta['updated']}'")
        if kind == "company" and meta.get("market") and meta["market"] not in MARKETS:
            problems.append(f"{rel}: market은 {', '.join(sorted(MARKETS))} 중 하나여야 합니다")
        for key in ("aliases", "themes", "keywords", "stages"):
            if key in meta and not isinstance(meta[key], list):
                problems.append(f"{rel}: {key}는 [a, b] 목록이어야 합니다")
        if "## 사람 메모" not in body:
            problems.append(f"{rel}: '## 사람 메모' 칸이 없습니다")

        for title in SOURCED_SECTIONS:
            for line in section(body, title).splitlines():
                if line.startswith("- ") and "http" not in line:
                    problems.append(f"{rel}: 출처 없는 줄 ({title}) {line[:50]}")
        for line in section(body, "최근 이슈").splitlines():
            if not line.startswith("- "):
                continue
            match = ISSUE.match(line.strip())
            if not (match and valid_date(match.group(1)) and match.group(2) in ISSUE_KINDS):
                problems.append(f"{rel}: 이슈 형식이 틀립니다 (- YYYY-MM-DD [종류] 내용 · [[테마]] · [출처](URL)) {line[:50]}")
            elif kind == "company" and not any(t in names and t in theme_names for t in LINK.findall(line)):
                problems.append(f"{rel}: 이슈에 [[테마]] 링크가 없습니다 (테마와 관련된 사실만 이슈로 적습니다) {line[:50]}")
        if kind == "theme" and not re.search(r"^## 관련 기업", body, re.M):
            problems.append(f"{rel}: '## 관련 기업' 칸이 없습니다 (build_graph.py가 표를 넣을 자리)")

    for name, count in inbound.items():
        meta = loaded[name][1]
        if count == 0 and (meta.get("type") in REQUIRED or loaded[name][0].parent.name in FOLDER_KIND):
            problems.append(f"{loaded[name][0].relative_to(WIKI)}: 고아 페이지 (들어오는 링크 없음)")


def check_relations(loaded, problems):
    year_ago = today_kst() - timedelta(days=365)
    unlinked = collections.defaultdict(set)
    for name, (path, meta, body) in loaded.items():
        if meta.get("type") != "company":
            continue
        rel = path.relative_to(WIKI)
        for row in relations(body):
            if row["malformed"]:
                problems.append(f"{rel}: 관계 표 줄의 칸 수가 5개가 아닙니다 (관계|상대|내용|날짜|출처) {row['detail'][:60]}")
                continue
            if row["type"] not in PAIRS:
                problems.append(f"{rel}: 모르는 관계 종류 '{row['type']}'")
                continue
            if not row["sources"]:
                problems.append(f"{rel}: 출처 없는 관계 {row['type']} {row['target']}")
            if not (DATE.match(row["date"]) and valid_date(row["date"])):
                problems.append(f"{rel}: 관계 날짜 형식이 틀립니다 {row['target']} '{row['date']}'")
            elif row["date"] < year_ago.isoformat():
                problems.append(f"{rel}: 1년 넘게 갱신되지 않은 관계 {row['type']} {row['target']} ({row['date']})")
            if not row["linked"]:
                unlinked[row["target"]].add(name)
                continue
            if row["target"] not in loaded or loaded[row["target"]][1].get("type") != "company":
                continue
            partner = relations(loaded[row["target"]][2])
            if not any(p["target"] == name and p["type"] == PAIRS[row["type"]] for p in partner):
                problems.append(f"{rel}: 짝이 없는 관계 — [[{row['target']}]]에 '{PAIRS[row['type']]} [[{name}]]' 줄이 필요합니다")
    for target, sources in sorted(unlinked.items()):
        if target in loaded:
            problems.append(f"'{target}' 페이지가 있으니 관계 표에서 [[{target}]]로 링크하세요 ({', '.join(sorted(sources))})")
        elif len(sources) >= COUNTERPARTY_PAGE_AT:
            problems.append(f"페이지 없는 상대 '{target}'이 {len(sources)}개 기업에 나옵니다. 기업 페이지를 만드세요 ({', '.join(sorted(sources))})")


def check_stages(loaded, problems):
    themes = {name: (path, meta, body) for name, (path, meta, body) in loaded.items() if meta.get("type") == "theme"}
    chain_stage = {}
    for theme, (path, meta, body) in themes.items():
        rel = path.relative_to(WIKI)
        stages = meta.get("stages", [])
        if len(set(stages)) != len(stages):
            problems.append(f"{rel}: stages에 같은 단계가 두 번 있습니다")
        used = []
        for link in value_chain(body):
            used.append(link["stage"])
            if link["stage"] not in stages:
                problems.append(f"{rel}: 밸류체인 단계 '{link['stage']}'이 stages 목록에 없습니다")
            for company in link["companies"]:
                if (company, theme) in chain_stage:
                    problems.append(f"{rel}: [[{company}]]가 밸류체인 두 단계에 있습니다")
                chain_stage[(company, theme)] = link["stage"]
        for stage in stages:
            if stage not in used:
                problems.append(f"{rel}: stages의 '{stage}' 단계가 밸류체인에 없습니다")

    for name, (path, meta, body) in loaded.items():
        if meta.get("type") != "company":
            continue
        rel = path.relative_to(WIKI)
        roles = theme_roles(body)
        listed = set(meta.get("themes", []))
        for theme in listed - set(roles):
            problems.append(f"{rel}: themes에 '{theme}'가 있지만 '## 테마'에 줄이 없습니다")
        for theme in set(roles) - listed:
            problems.append(f"{rel}: '## 테마'에 [[{theme}]] 줄이 있지만 frontmatter themes에 없습니다")
        for theme, role in roles.items():
            if theme not in themes:
                problems.append(f"{rel}: 테마 '{theme}' 페이지가 없습니다")
                continue
            expected = chain_stage.get((name, theme), "")
            if role["stage"] != expected:
                if expected:
                    problems.append(f"{rel}: [[{theme}]] 단계가 '{role['stage'] or '없음'}'인데 테마 밸류체인에는 '{expected}'입니다")
                else:
                    problems.append(f"{rel}: [[{theme}]] 단계 '{role['stage']}'가 있지만 테마 밸류체인에 이 기업이 없습니다")
    for (company, theme), stage in chain_stage.items():
        if company in loaded and theme not in theme_roles(loaded[company][2]):
            problems.append(f"{loaded[company][0].relative_to(WIKI)}: [[{theme}]] 밸류체인('{stage}')에 있지만 '## 테마' 줄이 없습니다")


def check_identity(loaded, problems):
    owners = collections.defaultdict(list)
    for name, (path, meta, body) in loaded.items():
        if meta.get("type") not in REQUIRED:
            continue
        for alias in meta.get("aliases", []):
            if alias == name:
                problems.append(f"{path.relative_to(WIKI)}: 별칭 '{alias}'이 페이지 이름과 같습니다 (사이트 주소가 겹칩니다)")
            elif alias in loaded:
                problems.append(f"{path.relative_to(WIKI)}: 별칭 '{alias}'이 다른 페이지 이름과 같습니다")
            owners[("별칭", alias)].append(name)
        for key in ("dart_corp_code", "ticker"):
            if meta.get(key):
                owners[(key, meta[key])].append(name)
    for (key, value), names in owners.items():
        if len(names) > 1:
            problems.append(f"{key} '{value}'를 여러 페이지가 씁니다: {', '.join(names)}")


def check_generated(loaded, problems):
    """graph.json과 관련 기업 표가 위키 내용과 맞는지. 점수는 날짜에 따라 줄어드므로
    graph.json을 만든 날짜 기준으로 다시 계산해 비교한다(다음 날 점검해도 헛경보가 나지 않게)."""
    path = WIKI / "graph.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    built = current.get("updated", "")
    graph, tables = build(today=date.fromisoformat(built) if valid_date(built) else None)
    if {k: v for k, v in current.items() if k != "updated"} != {k: v for k, v in graph.items() if k != "updated"}:
        problems.append("wiki/graph.json이 최신이 아닙니다. python3 scripts/build_graph.py를 실행하세요")
    for theme, expected in tables.items():
        body = loaded[theme][2] if theme in loaded else ""
        if section(body, "관련 기업").strip() != expected.strip():
            problems.append(f"themes/{theme}.md: 관련 기업 표가 최신이 아닙니다. python3 scripts/build_graph.py를 실행하세요")


def main():
    files = sorted(WIKI.rglob("*.md"))
    pages_only = [path for path in files if not is_folder_index(path)]
    names = {path.stem: path for path in pages_only}
    problems, loaded = [], {}
    if len(names) != len(pages_only):
        duplicates = [stem for stem, n in collections.Counter(p.stem for p in pages_only).items() if n > 1]
        problems.append(f"같은 이름의 페이지가 여러 폴더에 있습니다: {', '.join(duplicates)}")
    check_pages(files, names, loaded, problems)
    check_relations(loaded, problems)
    check_stages(loaded, problems)
    check_identity(loaded, problems)
    check_generated(loaded, problems)

    for problem in problems:
        print(problem)
    print(f"점검 끝: 페이지 {len(files)}개, 문제 {len(problems)}개")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
