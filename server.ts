import { Elysia } from "elysia"
import { registerRoutes } from "./framework/router.ts"
import { setupHMR } from "./framework/hmr.ts"

const shell = await Bun.file("./index.html").text()
const app = await registerRoutes(new Elysia(), shell)

app.get("/bundle.js", () => {
  return new Response(Bun.file("./public/bundle.js"), {
    headers: { "Content-Type": "application/javascript" }
  })
})

setupHMR(app)

app.listen(3000)

console.log("BunFrame running at http://localhost:3000")