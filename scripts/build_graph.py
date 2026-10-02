#!/usr/bin/env python3
"""위키 페이지에 적힌 관계와 이슈를 모아 그래프 데이터와 테마별 관련 기업 표를 만든다.

- wiki/graph.json: 기업·테마·상대(페이지 없는 회사)를 점(node)으로, 관계를 선(edge)으로 담은 데이터.
  선마다 근거 목록(날짜, 내용, 원문 링크)이 붙는다. 기업 지도 페이지와 질문 답변이 이 파일을 쓴다.
- 각 테마 페이지의 '## 관련 기업' 표: CLAUDE.md의 점수 규칙으로 계산

    python3 scripts/build_graph.py
"""

import json
import re
from datetime import date

from wiki_common import WIKI, pages, today_kst

LINK = re.compile(r"\[\[([^\]|#\\]+)\\?(?:[|#][^\]]*)?\]\]")
CELL_SPLIT = re.compile(r"(?<!\\)\|")
URL = re.compile(r"\((https?://[^)\s]+)\)")
ISSUE = re.compile(r"^- (\d{4}-\d{2}-\d{2}) \[([^\]]+)\] (.*)$")
# 기업 페이지 테마 줄: - [[테마]] · 단계: 역할 (출처)
THEME_LINE = re.compile(r"^- \[\[([^\]|#]+)\]\](?: · ([^:]+?))?: (.*)$")
# 테마 페이지 밸류체인 줄: - 단계: [[회사]], [[회사]] (출처)
CHAIN_LINE = re.compile(r"^- ([^:\[]+?): (.*)$")
WEIGHTS = {"계약": 3, "수주": 3, "투자": 3, "인수합병": 3, "협력": 2, "실적": 1, "정책": 1, "기타": 1}
SECOND_ORDER = {"공급사", "고객사", "출자", "피출자"}
# 관계(기업 페이지 기준) -> 그래프 선 종류와 방향. True면 상대 -> 이 회사 방향
EDGE = {
    "고객사": ("공급", False), "공급사": ("공급", True),
    "출자": ("출자", False), "피출자": ("출자", True),
    "인수": ("인수", False), "피인수": ("인수", True),
    "계열": ("계열", None), "협력": ("협력", None), "경쟁": ("경쟁", None),
}
TABLE_NOTE = "<!-- scripts/build_graph.py가 만드는 표. 손으로 고치지 않는다 -->"


def section(body, title):
    match = re.search(rf"^## {re.escape(title)}\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    return match.group(1) if match else ""


def sources_of(text):
    """줄에 있는 출처 링크 주소 전부."""
    return URL.findall(text)


def valid_date(text):
    try:
        date.fromisoformat(text)
        return True
    except (TypeError, ValueError):
        return False


def strip_source(text):
    """줄에서 출처 링크('([매체](주소))', '· [매체](주소)', '[매체](주소)')를 모두 떼어 낸 본문."""
    text = re.sub(r"\s*\((?:\[[^\]]*\]\([^)]*\)(?:,\s*)?)+\)", "", text)
    text = re.sub(r"\s*·?\s*\[[^\]]*\]\(https?://[^)]*\)", "", text)
    return re.sub(r"\s+", " ", text).strip(" ·,")


def plain(text):
    """위키링크를 링크 대상 글자로 바꾼다. [[삼성전자]] -> 삼성전자"""
    return LINK.sub(lambda m: m.group(1).strip(), text)


def summary(body):
    match = re.search(r"^> (.+)$", body, re.M)
    return match.group(1).strip() if match else ""


def relations(body):
    """'## 관계' 표의 줄들. 칸이 5개가 아닌 줄은 malformed=True로 돌려준다(점검이 알린다)."""
    rows = []
    for line in section(body, "관계").splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip().replace("\\|", "|") for cell in CELL_SPLIT.split(line.strip("|"))]
        if cells[0] in ("관계", "") or set(cells[0]) <= {"-", ":", " "}:
            continue
        if len(cells) != 5:
            rows.append({"type": cells[0], "target": "", "linked": False, "detail": line, "date": "",
                         "sources": [], "malformed": True})
            continue
        target = LINK.search(cells[1])
        rows.append({
            "type": cells[0],
            "target": target.group(1).strip() if target else cells[1],
            "linked": bool(target),
            "detail": plain(cells[2]),
            "date": cells[3],
            "sources": sources_of(cells[4]),
            "malformed": False,
        })
    return rows


def issues(body):
    result = []
    for line in section(body, "최근 이슈").splitlines():
        match = ISSUE.match(line.strip())
        if not match:
            continue
        text = match.group(3)
        result.append({
            "date": match.group(1),
            "kind": match.group(2),
            "text": text,  # load()에서 테마 링크를 빼고 다듬는다
            "links": [name.strip() for name in LINK.findall(text)],
            "sources": sources_of(text),
        })
    return result


def theme_roles(body):
    """기업 페이지 '## 테마' 줄 -> {테마: {stage, role, source}}"""
    roles = {}
    for line in section(body, "테마").splitlines():
        match = THEME_LINE.match(line.strip())
        if match:
            roles[match.group(1).strip()] = {
                "stage": (match.group(2) or "").strip(),
                "role": strip_source(plain(match.group(3))),
                "sources": sources_of(match.group(3)),
            }
    return roles


def value_chain(body):
    """테마 페이지 '## 밸류체인' 줄 -> [{stage, companies, source}]"""
    chain = []
    for line in section(body, "밸류체인").splitlines():
        match = CHAIN_LINE.match(line.strip())
        if match:
            chain.append({
                "stage": match.group(1).strip(),
                "companies": [name.strip() for name in LINK.findall(match.group(2))],
                "sources": sources_of(match.group(2)),
            })
    return chain


def evidence_score(item, today):
    days = max((today - date.fromisoformat(item["date"])).days, 0)
    weight = WEIGHTS.get(item["kind"], 1)
    if any("dart.fss.or.kr" in url for url in item["sources"]):
        weight *= 1.5
    return weight * 0.5 ** (days / 90)


def load():
    themes = {}
    for name, path, meta, body in pages("themes"):
        themes[name] = {"meta": meta, "path": path, "summary": summary(body), "chain": value_chain(body)}
    companies = {}
    for name, path, meta, body in pages("companies"):
        found = []
        for item in issues(body):
            if not valid_date(item["date"]):
                continue  # 있을 수 없는 날짜는 점수에서 빼고, 점검(lint)이 알린다
            text = item.pop("text")
            for theme in item["links"]:
                if theme in themes:  # 테마 링크는 본문에서 빼고, 기업 링크는 이름만 남긴다
                    text = text.replace(f"[[{theme}]]", "")
            item["text"] = strip_source(plain(text))
            item["themes"] = [link for link in item.pop("links") if link in themes]
            found.append(item)
        companies[name] = {
            "meta": meta, "summary": summary(body), "relations": [r for r in relations(body) if not r["malformed"]],
            "issues": found, "roles": theme_roles(body),
        }
    return companies, themes


def score_theme(theme, info, companies, today):
    """테마 하나의 1차·2차 관련 기업과 점수."""
    stage_of = {c: link["stage"] for link in info["chain"] for c in link["companies"]}
    first = {}
    for name, company in companies.items():
        evidence = [i for i in company["issues"] if theme in i["themes"]]
        if evidence or name in stage_of:
            first[name] = {
                "tier": 1,
                "stage": stage_of.get(name, company["roles"].get(theme, {}).get("stage", "")),
                "score": round(sum(evidence_score(i, today) for i in evidence), 2),
                "evidence": [{k: i[k] for k in ("date", "kind", "text", "sources")} for i in evidence],
            }
    second = {}
    for name, company in companies.items():
        if name in first:
            continue
        links = [
            (rel["target"], rel["type"]) for rel in company["relations"]
            if rel["type"] in SECOND_ORDER and rel["target"] in first
        ]
        if links:
            via, kind = max(links, key=lambda link: (first[link[0]]["score"], link[0]))
            second[name] = {"tier": 2, "stage": "", "score": round(first[via]["score"] * 0.3, 2),
                            "via": via, "via_type": kind, "evidence": []}
    return first, second


def table(first, second, today):
    lines = [TABLE_NOTE, ""]
    if first:
        lines += ["### 1차 관련 기업", "", "| 순위 | 기업 | 단계 | 점수 | 근거 수 | 최근 근거 |", "|---|---|---|---|---|---|"]
        ranked = sorted(first.items(), key=lambda item: (-item[1]["score"], item[0]))
        for rank, (name, row) in enumerate(ranked, 1):
            latest = max((e["date"] for e in row["evidence"]), default="-")
            lines.append(f"| {rank} | [[{name}]] | {row['stage'] or '-'} | {row['score']:.1f} | "
                         f"{len(row['evidence'])} | {latest} |")
    if second:
        lines += ["", "### 2차 관련 기업", "", "| 기업 | 점수 | 이어진 1차 기업 | 관계 |", "|---|---|---|---|"]
        for name, row in sorted(second.items(), key=lambda item: (-item[1]["score"], item[0])):
            lines.append(f"| [[{name}]] | {row['score']:.1f} | [[{row['via']}]] | {row['via_type']} |")
    if not (first or second):
        lines.append("아직 근거가 있는 기업이 없습니다.")
    lines += ["", f"점수: 근거마다 가중치 × 0.5^(경과일/90)의 합, {today} 기준. 계산 방법은 첫 화면(index)의 '보는 법'에 있습니다."]
    return "\n".join(lines)


def build(today=None):
    """(그래프 dict, {테마: 관련 기업 표}) 를 돌려준다. 파일은 쓰지 않는다."""
    today = today or today_kst()
    companies, themes = load()
    nodes, edges, tables = [], {}, {}

    theme_links = {}
    for theme, info in themes.items():
        first, second = score_theme(theme, info, companies, today)
        tables[theme] = table(first, second, today)
        for name, row in {**first, **second}.items():
            theme_links.setdefault(name, []).append({"theme": theme, **row})
        nodes.append({"id": theme, "type": "theme", "path": f"themes/{theme}", "summary": info["summary"],
                      "stages": info["meta"].get("stages", [])})

    externals = set()
    for name, company in companies.items():
        meta = company["meta"]
        links = sorted(theme_links.get(name, []), key=lambda link: link["theme"])
        nodes.append({
            "id": name, "type": "company", "path": f"companies/{name}", "summary": company["summary"],
            "market": meta.get("market", ""), "ticker": meta.get("ticker", ""),
            "dart_corp_code": meta.get("dart_corp_code", ""), "aliases": meta.get("aliases", []),
            "themes": [{k: v for k, v in link.items() if k != "evidence"} for link in links],
        })
        for link in links:
            key = (name, link["theme"], "테마")
            edges[key] = {"source": name, "target": link["theme"], "type": "테마", "tier": link["tier"],
                          "stage": link["stage"], "score": link["score"], "evidence": link["evidence"]}
        for rel in company["relations"]:
            if rel["type"] not in EDGE:
                continue
            kind, reverse = EDGE[rel["type"]]
            source, target = (rel["target"], name) if reverse else (name, rel["target"])
            if reverse is None:
                source, target = sorted((name, rel["target"]))
            if not rel["linked"]:
                externals.add(rel["target"])
            edge = edges.setdefault((source, target, kind),
                                    {"source": source, "target": target, "type": kind, "evidence": []})
            item = {"date": rel["date"], "text": rel["detail"], "sources": rel["sources"]}
            if not any(e["date"] == item["date"] and e["sources"] == item["sources"] for e in edge["evidence"]):
                edge["evidence"].append(item)

    for name in sorted(externals - set(companies)):
        nodes.append({"id": name, "type": "external", "path": None, "summary": "위키 페이지가 아직 없는 상대"})
    for edge in edges.values():
        edge["evidence"].sort(key=lambda e: e["date"], reverse=True)
    graph = {
        "updated": today.isoformat(),
        "nodes": nodes,
        "edges": sorted(edges.values(), key=lambda e: (e["type"], e["source"], e["target"])),
    }
    return graph, tables


def replace_section(text, title, content):
    """'## 제목' 칸의 내용을 바꾼다. 칸이 없으면 '## 최근 동향' 앞(없으면 끝)에 새로 넣는다."""
    pattern = re.compile(rf"(^## {re.escape(title)}\s*\n)(.*?)(?=^## |^---\s*$|\Z)", re.S | re.M)
    if pattern.search(text):
        return pattern.sub(lambda m: m.group(1) + content.strip() + "\n\n", text, count=1)
    block = f"## {title}\n{content.strip()}\n\n"
    anchor = re.search(r"^## 최근 동향", text, re.M)
    if anchor:
        return text[:anchor.start()] + block + text[anchor.start():]
    return text.rstrip() + "\n\n" + block


def main():
    graph, tables = build()
    for theme, path, _, _ in pages("themes"):
        text = path.read_text(encoding="utf-8")
        new_text = replace_section(text, "관련 기업", tables[theme])
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
    (WIKI / "graph.json").write_text(json.dumps(graph, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    counts = {}
    for node in graph["nodes"]:
        counts[node["type"]] = counts.get(node["type"], 0) + 1
    print(f"점 {counts}, 선 {len(graph['edges'])}개 -> wiki/graph.json, 테마 표 갱신")


if __name__ == "__main__":
    main()
