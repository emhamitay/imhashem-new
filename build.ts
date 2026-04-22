await Bun.build({
  entrypoints: ["./client.ts"],
  outdir: "./.bunframe",
  naming: "bundle.js",
  target: "browser",
})

console.log("Client bundle built successfully")