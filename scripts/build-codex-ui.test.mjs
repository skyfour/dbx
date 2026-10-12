import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createWorkbenchHtml } from "./build-codex-ui.mjs";

test("packs the complete workbench without external scripts and preserves bootstrap syntax", () => {
  const html = createWorkbenchHtml(
    '<html><head><link rel="stylesheet" href="assets/app.css"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>',
    [
      { name: "assets/app.js", type: "text/javascript", text: 'new Worker(new URL("assets/worker.js",import.meta.url))' },
      { name: "assets/worker.js", type: "text/javascript", text: 'postMessage("worker")' },
      { name: "assets/app.css", type: "text/css", text: "body{color:red}" },
    ],
    'function installCodexTransport(){return Promise.resolve("$&");}',
    "1.2.3",
  );
  assert.doesNotMatch(html, /<iframe|<script[^>]+src=|<link[^>]+stylesheet/);
  const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new vm.Script(source, { importModuleDynamically: () => {} });
  assert.match(source, /installCodexTransport\("1.2.3"\)/);
  const rewriteSource = source.match(/const rewrite=\(text,resources=aliases\)=>\{[^\n]+/)[0];
  const result = vm.runInNewContext(rewriteSource + ";rewrite('new URL(\"assets/worker.js\",import.meta.url)')", { aliases: new Map([["assets/worker.js", "blob:worker"]]) });
  assert.equal(result, 'new URL("blob:worker",import.meta.url)');
});

test("rewrites worker modules without changing image paths passed to webPath", () => {
  const html = createWorkbenchHtml(
    '<body><script type="module" src="./assets/app.js"></script></body>',
    [{ name: "assets/app.js", type: "text/javascript", text: "" }],
    "function installCodexTransport(){}", "1.2.3",
  );
  const rewriteSource = html.match(/const rewrite=\(text,resources=aliases\)=>\{[^\n]+/)[0];
  const aliases = new Map([["/logo.png", "blob:logo"], ["assets/worker.js", "blob:worker"]]);
  const input = 'webPath("/logo.png");new URL("assets/worker.js",import.meta.url)';
  const result = vm.runInNewContext(rewriteSource + ";rewrite(input,modules)", {
    aliases, modules: new Map([["assets/worker.js", "blob:worker"]]), input,
  });
  assert.equal(result, 'webPath("/logo.png");new URL("blob:worker",import.meta.url)');
  assert.match(html, /globalThis\.__DBX_CODEX_ASSETS__=aliases/);
});
