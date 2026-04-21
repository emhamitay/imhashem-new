import { Elysia } from "elysia"
import { renderToReadableStream } from "react-dom/server"
import { createElement } from "react"
import Page from "./app/page.tsx"

const shell = await Bun.file("./index.html").text()

const app = new Elysia()
  .get("/", async () => {
    const stream = await renderToReadableStream(createElement(Page))
    await stream.allReady

    const html = await new Response(stream).text()
    const fullPage = shell.replace("<!--SSR-->", html)

    return new Response(fullPage, {
      headers: { "Content-Type": "text/html" }
    })
  })
  .get("/bundle.js", () => {
    return new Response(Bun.file("./public/bundle.js"), {
      headers: { "Content-Type": "application/javascript" }
    })
  })
  .listen(3000)

console.log("BunFrame running at http://localhost:3000")