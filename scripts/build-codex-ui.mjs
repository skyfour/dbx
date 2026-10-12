import { build, transformWithOxc } from "vite";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main() {
  await build({ configFile: join(root, "apps/desktop/vite.codex.config.ts") });
  const output = join(root, "target/codex-ui");
  const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".jpg": "image/jpeg", ".json": "application/json" };
  const assets = [];
  async function collect(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory()) await collect(join(directory, item.name), name + "/");
      else if (name !== "index.html") {
        const bytes = await readFile(join(directory, item.name));
        const suffix = "." + item.name.split(".").at(-1);
        assets.push({ name, type: types[suffix] ?? "application/octet-stream", ...([".js", ".css", ".svg", ".json", ".txt"].includes(suffix) ? { text: bytes.toString("utf8") } : { data: bytes.toString("base64") }) });
      }
    }
  }
  await collect(output);
  const index = await readFile(join(output, "index.html"), "utf8");
  const source = await readFile(join(root, "apps/desktop/src/lib/backend/codexTransport.ts"), "utf8");
  const transport = (await transformWithOxc(source, "codexTransport.ts")).code.replace(/^export\s*\{[^}]*\};?\s*$/m, "").replace(/^export /gm, "");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const html = createWorkbenchHtml(index, assets, transport, version);
  const destination = resolve(process.argv[2] ?? join(root, "target/codex-ui-workbench.html"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, html);
  console.log(JSON.stringify({ destination, bytes: Buffer.byteLength(html), assets: assets.length }));
}

export function createWorkbenchHtml(index, assets, transport, version) {
  const main = index.match(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/)?.[1]?.replace(/^\.\//, "");
  if (!main || !assets.some((a) => a.name === main)) throw new Error("Workbench module missing");
  const packed = gzipSync(Buffer.from(JSON.stringify(assets))).toString("base64");
  const bootstrap = `
${transport}
await installCodexTransport(${JSON.stringify(version)});
const packed=Uint8Array.from(atob('${packed}'),c=>c.charCodeAt(0));
const files=JSON.parse(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
const urls=new Map(),aliases=new Map(),modules=new Map();
const bytes=file=>file.text!==undefined?new TextEncoder().encode(file.text):Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));
const register=(file,blob)=>{const url=URL.createObjectURL(blob);urls.set(file.name,url);for(const path of [file.name,'/'+file.name,'./'+file.name,'../'+file.name,...(file.type==='text/javascript'?[file.name.split('/').at(-1)]:[])]){aliases.set(path,url);if(file.type==='text/javascript')modules.set(path,url);}};
for(const file of files.filter(f=>f.type!=='text/javascript'&&f.type!=='text/css'))register(file,new Blob([bytes(file)],{type:file.type}));
const rewrite=(text,resources=aliases)=>{if(!resources.size)return text;const paths=[...resources.keys()].sort((a,b)=>b.length-a.length);const pattern=new RegExp(paths.map(p=>Array.from(p,c=>'\\\\x'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('')).join('|'),'g');return text.replace(pattern,path=>resources.get(path));};
for(const file of files.filter(f=>f.type==='text/javascript'&&f.name!==${JSON.stringify(main)}))register(file,new Blob([rewrite(new TextDecoder().decode(bytes(file)),modules)],{type:file.type}));
for(const file of files.filter(f=>f.type==='text/css')){const style=document.createElement('style');style.textContent=rewrite(new TextDecoder().decode(bytes(file)));document.head.append(style);}
const update=node=>{if(!(node instanceof Element))return;for(const element of [node,...node.querySelectorAll('[src],[href],[poster]')])for(const attribute of ['src','href','poster']){const value=element.getAttribute(attribute);if(value&&aliases.has(value))element.setAttribute(attribute,aliases.get(value));}};
new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')update(record.target);for(const node of record.addedNodes)update(node);}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','poster']});update(document.documentElement);
globalThis.__DBX_CODEX_ASSETS__=aliases;
const main=files.find(f=>f.name===${JSON.stringify(main)});await import(URL.createObjectURL(new Blob([rewrite(new TextDecoder().decode(bytes(main)),modules)],{type:'text/javascript'})));
`;
  const script = `(async()=>{${bootstrap}})().catch(error=>{const root=document.querySelector('#root');if(root){root.replaceChildren();const message=document.createElement('pre');message.textContent='DBX startup failed: '+error.message;root.append(message);}console.error(error);});`;
  // The complete workbench is an MCP resource; the panel makes no loopback network requests.
  return index
    .replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/g, "")
    .replace(/<link[^>]+(?:rel="(?:stylesheet|modulepreload)")[^>]*>/g, "")
    .replace("</body>", () => `<script>${script.replaceAll("</script", "<\\/script")}</script></body>`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
