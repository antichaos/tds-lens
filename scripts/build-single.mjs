// Build dist/tds-lens.html and dist/calc-lens.html: each app in ONE file that works offline
// when opened from disk (file://), where browsers refuse to load separate JS modules.
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
const ident = (mod) => `__mod_${mod.replace(/-/g, "_")}`;

function bundle(modules) {
  const parts = [];
  for (const name of modules) {
    let src = web(`js/${name}.js`);
    const imports = [];
    src = src.replace(/import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w-]+)\.js["'];?/g, (_, names, mod) => {
      if (!modules.includes(mod)) throw new Error(`${name}.js imports ${mod}.js, which is not in the module list`);
      imports.push(`const {${names}} = ${ident(mod)};`);
      return "";
    });
    if (/^\s*import[\s{*"']/m.test(src)) throw new Error(`Unsupported import in ${name}.js`);
    const exported = [];
    src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind} ${id}`;
    });
    if (/^export\s/m.test(src)) throw new Error(`Unsupported export in ${name}.js`);
    parts.push(`const ${ident(name)} = (() => {\n${imports.join("\n")}\n${src}\nreturn { ${exported.join(", ")} };\n})();`);
  }
  return parts.join("\n\n");
}

const scriptSafe = (s) => s.replace(/<\/script/gi, "<\\/script");
const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const favicon = `data:image/svg+xml;base64,${Buffer.from(web("favicon.svg")).toString("base64")}`;
const jszip = scriptSafe(web("vendor/jszip.min.js"));

/** One page -> one self-contained file. `links` are page-specific [from, to] replacements. */
function buildPage({ page, out, modules, entry, sample, sampleGlobal, links }) {
  const sampleJs = `globalThis.${sampleGlobal} = ${scriptSafe(JSON.stringify(web(sample)))};`;
  const app = scriptSafe(bundle(modules));
  let html = web(page);
  const csp = [
    "default-src 'none'",
    `script-src ${sha(jszip)} ${sha(sampleJs)} ${sha(app)}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`${page} changed, cannot find: ${from}`);
    html = html.replace(from, () => to);
  };
  replace(html.match(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/)[0],
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  replace(`<link rel="icon" href="favicon.svg" type="image/svg+xml">`, `<link rel="icon" href="${favicon}" type="image/svg+xml">`);
  replace(`<img src="favicon.svg"`, `<img src="${favicon}"`);
  replace(`<link rel="stylesheet" href="css/app.css">`, `<style>\n${web("css/app.css")}</style>`);
  replace(`<script src="vendor/jszip.min.js"></script>`, `<script>${jszip}</script>\n  <script>${sampleJs}</script>`);
  replace(`<script type="module" src="js/${entry}.js"></script>`, `<script type="module">${app}</script>`);
  for (const [from, to] of links) replace(from, to);

  writeFileSync(join(root, "dist", out), html);
  console.log(`dist/${out}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
}

mkdirSync(join(root, "dist"), { recursive: true });

buildPage({
  page: "index.html", out: "tds-lens.html", entry: "app",
  modules: ["parse", "diagram", "checks", "compare", "report", "app"], // dependency order
  sample: "samples/superstore_sample.tds", sampleGlobal: "TDS_LENS_SAMPLE",
  links: [
    [`<a class="brand" href="./"`, `<a class="brand" href="${SITE}"`],
    [`<a href="calcs.html">`, `<a href="${SITE}calcs.html">`],
    // the offline file links to the website; the website links to the offline file
    [`<a href="tds-lens.html" download>Offline version (single file)</a>`, `<a href="${SITE}">Online version</a>`],
  ],
});

buildPage({
  page: "calcs.html", out: "calc-lens.html", entry: "calcs-app",
  modules: ["parse", "calcs", "calcs-app"],
  sample: "samples/superstore_calcs.twb", sampleGlobal: "CALC_LENS_SAMPLE",
  links: [
    [`<a class="brand" href="calcs.html"`, `<a class="brand" href="${SITE}calcs.html"`],
    [`<a href="./">`, `<a href="${SITE}">`],
    [`<a href="calc-lens.html" download>Offline version (single file)</a>`, `<a href="${SITE}calcs.html">Online version</a>`],
  ],
});
