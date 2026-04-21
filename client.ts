import { hydrateRoot } from "react-dom/client"
import { createElement } from "react"
import Page from "./app/page.tsx"

hydrateRoot(
  document.getElementById("root")!,
  createElement(Page)
)