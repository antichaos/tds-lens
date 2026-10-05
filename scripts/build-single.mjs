// Build dist/tds-lens.html: the whole app in ONE file that works offline when
// opened from disk (file://), where browsers refuse to load separate JS modules.
// No dependencies: CSS, JSZip, the ES modules, the icon and the sample are inlined,
// and the Content Security Policy allows exactly these inline scripts (by hash).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = (p) => readFileSync(join(root, "web", p), "utf8");
const SITE = "https://antichaos.github.io/tds-lens/";

// --- bundle the ES modules into one module script ------------------------------
// Each module becomes a scope that returns its exports; imports become destructuring.
const MODULES = ["parse", "diagram", "checks", "compare", "report", "app"]; // dependency order

function bundle() {
  const parts = [];
  for (const name of MODULES) {
    let src = web(`js/${name}.js`);
    const imports = [];
    src = src.replace(/import\s*\{([^}]*)\}\s*from\s*["']\.\/(\w+)\.js["'];?/g, (_, names, mod) => {
      imports.push(`const {${names}} = __mod_${mod};`);
      return "";
    });
    if (/^\s*import[\s{*"']/m.test(src)) throw new Error(`Unsupported import in ${name}.js`);
    const exported = [];
    src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind} ${id}`;
    });
    if (/^export\s/m.test(src)) throw new Error(`Unsupported export in ${name}.js`);
    parts.push(`const __mod_${name} = (() => {\n${imports.join("\n")}\n${src}\nreturn { ${exported.join(", ")} };\n})();`);
  }
  return parts.join("\n\n");
}

const scriptSafe = (s) => s.replace(/<\/script/gi, "<\\/script");
const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const favicon = `data:image/svg+xml;base64,${Buffer.from(web("favicon.svg")).toString("base64")}`;
const jszip = scriptSafe(web("vendor/jszip.min.js"));
const sample = `globalThis.TDS_LENS_SAMPLE = ${scriptSafe(JSON.stringify(web("samples/superstore_sample.tds")))};`;
const app = scriptSafe(bundle());

let html = web("index.html");
const csp = [
  "default-src 'none'",
  `script-src ${sha(jszip)} ${sha(sample)} ${sha(app)}`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const replace = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html changed, cannot find: ${from}`);
  html = html.replace(from, () => to);
};
replace(html.match(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/)[0],
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
replace(`<link rel="icon" href="favicon.svg" type="image/svg+xml">`, `<link rel="icon" href="${favicon}" type="image/svg+xml">`);
replace(`<img src="favicon.svg"`, `<img src="${favicon}"`);
replace(`<link rel="stylesheet" href="css/app.css">`, `<style>\n${web("css/app.css")}</style>`);
replace(`<script src="vendor/jszip.min.js"></script>`, `<script>${jszip}</script>\n  <script>${sample}</script>`);
replace(`<script type="module" src="js/app.js"></script>`, `<script type="module">${app}</script>`);
replace(`<a class="brand" href="./"`, `<a class="brand" href="${SITE}"`);
// the offline file links to the website; the website links to the offline file
replace(`<a href="tds-lens.html" download>Offline version (single file)</a>`, `<a href="${SITE}">Online version</a>`);

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "tds-lens.html"), html);
console.log(`dist/tds-lens.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
