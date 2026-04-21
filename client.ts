import { hydrateRoot } from "react-dom/client"
import { createElement } from "react"
import { Counter } from "./components/Counter.tsx"

const counterRoot = document.getElementById("counter-root")

if (counterRoot) {
  hydrateRoot(counterRoot, createElement(Counter))
}