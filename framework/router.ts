import { Elysia } from "elysia";
import { renderToReadableStream } from "react-dom/server";
import { createElement } from "react";

function normalizeRoutePath(file: string) {
  const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const appRelativeFile = normalizedFile.replace(/^app\//, "").replace(/^\/+/, "");
  const normalizedRoute = appRelativeFile
    .replace(/(?:^|\/)page\.tsx$/, "")
    .replace(/^\/+|\/+$/g, "");

  return {
    normalizedFile: appRelativeFile,
    route: normalizedRoute === "" ? "/" : `/${normalizedRoute}`,
  };
}

export async function registerRoutes(app: Elysia, shell: string) {
  const glob = new Bun.Glob("**/page.tsx");
  let routedApp = app;

  for await (const file of glob.scan("./app")) {
    const { normalizedFile, route } = normalizeRoutePath(file);

    const mod = await import(`../app/${normalizedFile}`);
    const Page = mod.default;

    routedApp = routedApp.get(route, async () => {
      const stream = await renderToReadableStream(createElement(Page));
      await stream.allReady;
      const html = await new Response(stream).text();
      const fullPage = shell.replace("<!--SSR-->", html);
      return new Response(fullPage, {
        headers: { "Content-Type": "text/html" },
      });
    });

    console.log(`Registered route: ${route}`);
  }

  return routedApp;
}
