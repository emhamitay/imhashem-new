await Bun.build({
  entrypoints: ["./client.ts"],
  outdir: "./public",
  naming: "bundle.js",
  target: "browser",
})

console.log("Client bundle built successfully")