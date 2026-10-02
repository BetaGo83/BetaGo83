#!/usr/bin/env python3
"""위키 페이지에 적힌 관계와 이슈를 모아 그래프 데이터와 테마별 관련 기업 표를 만든다.

- wiki/graph.json: 기업·테마를 점(node), 관계를 선(edge)으로 담은 데이터
- 각 테마 페이지의 '## 관련 기업' 표: CLAUDE.md의 점수 규칙으로 계산

    python3 scripts/build_graph.py
"""

import json
import re
from datetime import date

from wiki_common import WIKI, pages

LINK = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
URL = re.compile(r"\((https?://[^)\s]+)\)")
ISSUE = re.compile(r"^- (\d{4}-\d{2}-\d{2}) \[([^\]]+)\]")
WEIGHTS = {"계약": 3, "수주": 3, "투자": 3, "인수합병": 3, "협력": 2, "실적": 1, "정책": 1, "기타": 1}
SECOND_ORDER = {"공급사", "고객사", "출자", "피출자"}
TABLE_NOTE = "<!-- scripts/build_graph.py가 만드는 표. 손으로 고치지 않는다 -->"


def section(body, title):
    match = re.search(rf"^## {re.escape(title)}\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    return match.group(1) if match else ""


def relations(body):
    rows = []
    for line in section(body, "관계").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 5 or cells[0] in ("관계", "") or set(cells[0]) <= {"-", ":"}:
            continue
        target = LINK.search(cells[1])
        url = URL.search(cells[4])
        rows.append({
            "type": cells[0],
            "target": target.group(1).strip() if target else cells[1],
            "linked": bool(target),
            "detail": cells[2],
            "date": cells[3],
            "source": url.group(1) if url else "",
        })
    return rows


def issues(body):
    result = []
    for line in section(body, "최근 이슈").splitlines():
        match = ISSUE.match(line.strip())
        if not match:
            continue
        url = URL.search(line)
        result.append({
            "date": match.group(1),
            "kind": match.group(2),
            "themes": [name.strip() for name in LINK.findall(line)],
            "source": url.group(1) if url else "",
        })
    return result


def evidence_score(item, today):
    days = max((today - date.fromisoformat(item["date"])).days, 0)
    weight = WEIGHTS.get(item["kind"], 1)
    if "dart.fss.or.kr" in item["source"]:
        weight *= 1.5
    return weight * 0.5 ** (days / 90)


def build_table(theme, companies, value_chain, today):
    first = {}
    for name, info in companies.items():
        evidence = [i for i in info["issues"] if theme in i["themes"]]
        if evidence or name in value_chain:
            first[name] = {
                "score": sum(evidence_score(i, today) for i in evidence),
                "count": len(evidence),
                "latest": max((i["date"] for i in evidence), default="-"),
            }
    second = {}
    for name, info in companies.items():
        if name in first:
            continue
        links = [
            (rel["target"], rel["type"]) for rel in info["relations"]
            if rel["type"] in SECOND_ORDER and rel["target"] in first
        ]
        if links:
            via, kind = max(links, key=lambda link: first[link[0]]["score"])
            second[name] = {"score": first[via]["score"] * 0.3, "via": via, "kind": kind}

    lines = [TABLE_NOTE, ""]
    if first:
        lines += ["### 1차 관련 기업", "", "| 순위 | 기업 | 점수 | 근거 수 | 최근 근거 |", "|---|---|---|---|---|"]
        ranked = sorted(first.items(), key=lambda item: (-item[1]["score"], item[0]))
        for rank, (name, row) in enumerate(ranked, 1):
            lines.append(f"| {rank} | [[{name}]] | {row['score']:.1f} | {row['count']} | {row['latest']} |")
    if second:
        lines += ["", "### 2차 관련 기업", "", "| 기업 | 점수 | 이어진 1차 기업 | 관계 |", "|---|---|---|---|"]
        for name, row in sorted(second.items(), key=lambda item: (-item[1]["score"], item[0])):
            lines.append(f"| [[{name}]] | {row['score']:.1f} | [[{row['via']}]] | {row['kind']} |")
    if not (first or second):
        lines.append("아직 근거가 있는 기업이 없습니다.")
    lines.append("")
    lines.append(f"점수: 근거마다 가중치 × 0.5^(경과일/90)의 합, {today} 기준. 계산 방법은 [[index]]를 참고하세요.")
    return "\n".join(lines)


def replace_section(text, title, content):
    pattern = re.compile(rf"(^## {re.escape(title)}\s*\n)(.*?)(?=^## |\Z)", re.S | re.M)
    return pattern.sub(lambda m: m.group(1) + content.strip() + "\n\n", text, count=1)


def main():
    today = date.today()
    companies = {}
    for name, _, meta, body in pages("companies"):
        companies[name] = {"meta": meta, "relations": relations(body), "issues": issues(body)}
    themes = pages("themes")

    nodes, edges, seen = [], [], set()
    for name, info in companies.items():
        nodes.append({"id": name, "type": "company", "market": info["meta"].get("market", ""),
                      "themes": info["meta"].get("themes", [])})
        for theme in info["meta"].get("themes", []):
            edges.append({"source": name, "target": theme, "type": "테마"})
        for rel in info["relations"]:
            if not rel["linked"]:
                continue
            key = tuple(sorted((name, rel["target"]))) + (rel["detail"],)
            if key in seen:  # 짝이 되는 관계는 한 번만 담는다
                continue
            seen.add(key)
            edges.append({"source": name, "target": rel["target"], "type": rel["type"],
                          "detail": rel["detail"], "date": rel["date"], "url": rel["source"]})

    for theme, path, meta, body in themes:
        nodes.append({"id": theme, "type": "theme"})
        value_chain = set(LINK.findall(section(body, "밸류체인")))
        table = build_table(theme, companies, value_chain, today)
        text = path.read_text(encoding="utf-8")
        new_text = replace_section(text, "관련 기업", table)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")

    graph = {"updated": today.isoformat(), "nodes": nodes, "edges": edges}
    (WIKI / "graph.json").write_text(json.dumps(graph, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"기업 {len(companies)}개, 테마 {len(themes)}개, 선 {len(edges)}개 -> wiki/graph.json, 테마 표 갱신")


if __name__ == "__main__":
    main()
