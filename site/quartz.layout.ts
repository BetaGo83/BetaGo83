// 이 파일은 GitHub Actions가 Quartz를 받은 뒤 quartz.layout.ts 자리에 덮어쓴다.
// 페이지 배치 설명: https://quartz.jzhao.xyz/layout
import { h } from "preact"
import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import { QuartzComponent, QuartzComponentConstructor } from "./quartz/components/types"
import { pathToRoot } from "./quartz/util/path"

const DISCLAIMER =
  "AI가 뉴스와 공시를 바탕으로 정리한 참고 자료입니다. 틀린 내용이 있을 수 있으니 원문을 확인하세요. 투자 권유가 아닙니다."

// 모든 페이지 아래에 면책 문구와 링크를 넣는 하단 영역
const SiteFooter = (() => {
  const Footer: QuartzComponent = ({ displayClass, fileData, cfg }) => {
    // 404 페이지는 아무 주소에서나 보이므로 상대 경로 대신 사이트 기본 경로를 쓴다 (Head.tsx와 같은 방식)
    const root =
      fileData.slug === "404"
        ? new URL(`https://${cfg.baseUrl ?? "example.com"}`).pathname.replace(/\/$/, "")
        : pathToRoot(fileData.slug!)
    return h(
      "footer",
      { class: displayClass ?? "" },
      h("p", { class: "disclaimer" }, DISCLAIMER),
      h(
        "ul",
        null,
        // 기업 지도는 Quartz 페이지가 아니라서 페이지 전환 기능(SPA)이 가로채지 않게 한다
        h("li", null, h("a", { href: `${root}/static/map.html`, "data-router-ignore": "" }, "기업 지도")),
        h("li", null, h("a", { href: "https://github.com/BetaGo83/BetaGo83" }, "GitHub")),
        h("li", null, h("a", { href: "https://quartz.jzhao.xyz/" }, "Quartz로 만듦")),
      ),
    )
  }
  // 하단 영역 CSS는 모든 페이지에 들어가므로 사이트 전체 글자 모양도 여기서 정한다
  Footer.css = `
footer { text-align: left; margin-bottom: 4rem; opacity: 0.8; }
footer .disclaimer { font-size: 0.9rem; }
footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
/* 한국어 낱말이 중간에서 끊기지 않게 (띄어쓰기에서만 줄을 바꾼다) */
.page-title, article p, article li, article blockquote, footer p, .section h3,
article table th, article table td, .preview-inner table th, .preview-inner table td { word-break: keep-all; overflow-wrap: break-word; }
.search-button p { white-space: nowrap; }
@media (max-width: 800px) { .page-title { font-size: 1.4rem; } }
/* 표의 날짜 칸(관계 표 4번째, 관련 기업 표 6번째)은 하이픈에서 끊기지 않게 한 줄로 */
article table td:nth-child(4), article table td:nth-child(6),
.preview-inner table td:nth-child(4), .preview-inner table td:nth-child(6) { white-space: nowrap; }
/* Quartz의 칸 최소 너비(75px)와 표 좌우 여백을 풀어 순위·점수 같은 좁은 칸이 자리를 덜 차지하게 하고,
   관계 표(5칸)의 내용 칸만 넓게 둔다 (Quartz 규칙 '.table-container>table td'보다 우선하도록 article을 붙인다) */
article .table-container > table, .preview-inner .table-container > table { margin: 1rem 0; }
article .table-container > table th, article .table-container > table td,
.preview-inner .table-container > table th, .preview-inner .table-container > table td { min-width: 0; }
article .table-container > table:not(:has(th:nth-child(6))) td:nth-child(3) { min-width: 9em; }
`
  return Footer
}) satisfies QuartzComponentConstructor

// 탐색기에서 영어 폴더 이름을 한국어로 보여 준다 (폴더 안내 페이지 companies/index.md, themes/index.md의 제목도 같다)
const explorer = Component.Explorer({
  mapFn: (node) => {
    if (node.isFolder && node.slugSegment === "companies") node.displayName = "기업"
    if (node.isFolder && node.slugSegment === "themes") node.displayName = "테마"
  },
})

// 모든 페이지에 같이 들어가는 부분
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: SiteFooter(),
}

const breadcrumbs = Component.Breadcrumbs({ rootName: "처음" })

// 위키 페이지 하나를 보여 줄 때. 페이지 본문이 '# 제목'으로 시작하므로 ArticleTitle은 넣지 않는다(제목이 두 번 나옴)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: breadcrumbs,
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ContentMeta({ showReadingTime: false }),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        { Component: Component.Search(), grow: true },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    explorer,
  ],
  right: [
    // 옵시디언처럼 페이지끼리 이어진 그림. 오른쪽 위 버튼을 누르면 전체 그림이 열린다
    Component.Graph({
      localGraph: { depth: 1, showTags: false },
      globalGraph: { depth: -1, showTags: false },
    }),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// 폴더나 태그처럼 페이지 목록을 보여 줄 때
export const defaultListPageLayout: PageLayout = {
  beforeBody: [breadcrumbs, Component.ArticleTitle(), Component.ContentMeta({ showReadingTime: false })],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [{ Component: Component.Search(), grow: true }, { Component: Component.Darkmode() }],
    }),
    explorer,
  ],
  right: [],
}
