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
const SiteFooter: QuartzComponentConstructor = () => {
  const Footer: QuartzComponent = ({ displayClass, fileData }) => {
    const root = pathToRoot(fileData.slug!)
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
  Footer.css = `
footer { text-align: left; margin-bottom: 4rem; opacity: 0.8; }
footer .disclaimer { font-size: 0.9rem; }
footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
`
  return Footer
}

// 탐색기에서 영어 폴더 이름을 한국어로 보여 준다
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

// 위키 페이지 하나를 보여 줄 때
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
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
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
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
