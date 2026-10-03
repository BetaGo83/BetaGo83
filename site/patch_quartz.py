#!/usr/bin/env python3
"""GitHub Actions에서 받은 Quartz(v4.5.2 커밋 고정) 코드를 이 위키에 맞게 조금 고친다.

    python3 site/patch_quartz.py quartz      # deploy.yml이 Quartz를 받은 뒤 실행한다

바꿀 곳을 정해진 횟수만큼 찾지 못하면 멈춘다. Quartz를 올렸을 때 고친 내용이 조용히 빠지지 않게.
"""

import sys
from pathlib import Path

PATCHES = [
    # 한국어는 낱말 중간도 찾게 한다 ('하이닉스'로 'SK하이닉스', '본더'로 'TC본더'). 기본값은 낱말 앞부분만 찾는다
    ("quartz/components/scripts/search.inline.ts", 'tokenize: "forward"', 'tokenize: "full"', 3),
    # 검색 결과 미리보기도 낱말 중간 일치를 찾아 그 근처를 보여 준다 (안 고치면 페이지 끝부분이 나온다)
    ("quartz/components/scripts/search.inline.ts",
     "tokenizedTerms.some((term) => tok.toLowerCase().startsWith(term.toLowerCase()))",
     "tokenizedTerms.some((term) => tok.toLowerCase().includes(term.toLowerCase()))", 1),
    ("quartz/components/scripts/search.inline.ts", "<h3>No results.</h3>", "<h3>검색 결과가 없습니다.</h3>", 1),
    ("quartz/components/scripts/search.inline.ts", "<p>Try another search term?</p>", "<p>다른 검색어로 찾아보세요.</p>", 1),
    # 별칭(aliases)도 검색되게 한다 ('한수원'으로 '한국수력원자력'). 검색 결과 미리보기가 별칭 목록으로 시작하지 않게 본문 뒤에 붙인다
    ("quartz/plugins/emitters/contentIndex.tsx",
     'content: file.data.text ?? "",',
     'content: [file.data.text ?? "", ...(file.data.frontmatter?.aliases ?? [])].join(" "),', 1),
    # 처음 연 페이지가 탐색기 때문에 아래로 내려가 제목이 안 보이는 문제: 창 전체가 아니라 탐색기 목록만 움직인다
    ("quartz/components/scripts/explorer.inline.ts",
     'activeElement.scrollIntoView({ behavior: "smooth" })',
     "explorerUl.scrollTop += activeElement.getBoundingClientRect().top - explorerUl.getBoundingClientRect().top"
     " - explorerUl.clientHeight / 2", 1),
    ("quartz/i18n/locales/ko-KR.ts", 'title: "Not Found",', 'title: "페이지를 찾을 수 없습니다",', 1),
    ("quartz/components/Search.tsx", "<title>Search</title>", "<title>검색</title>", 1),
    ("quartz/components/Graph.tsx", 'aria-label="Global Graph"', 'aria-label="전체 그래프"', 1),
    # 링크 미리보기의 그림 형식이 'image/.png'로 나가는 Quartz 버그
    ("quartz/components/Head.tsx",
     'content={`image/${getFileExtension(ogImageDefaultPath) ?? "png"}`}', 'content="image/png"', 1),
]


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "quartz")
    for name, old, new, count in PATCHES:
        path = root / name
        text = path.read_text(encoding="utf-8")
        found = text.count(old)
        if found != count:
            sys.exit(f"고칠 곳을 못 찾음: {name}: '{old}' ({count}곳이어야 하는데 {found}곳)")
        path.write_text(text.replace(old, new), encoding="utf-8")
        print(f"고침: {name} ({count}곳)")


if __name__ == "__main__":
    main()
