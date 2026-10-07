// The single-file build must be self-contained and its CSP must allow exactly its inline scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const out of ["tds-lens.html", "calc-lens.html"]) {
  test(`single-file build is self-contained: ${out}`, () => {
    execFileSync("node", [join(root, "scripts/build-single.mjs")]);
    const html = readFileSync(join(root, "dist", out), "utf8");
    assert.doesNotMatch(html, /<script[^>]+src=/, "no external scripts");
    assert.doesNotMatch(html, /<link[^>]+stylesheet/, "no external stylesheets");
    assert.doesNotMatch(html, /from\s+["']\.\/[\w-]+\.js["']/, "no leftover module imports");
    assert.doesNotMatch(html, /href="(?!https:|#|data:)[^"]+"/, "no relative links");
    const scripts = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 3);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    for (const s of scripts) {
      const hash = createHash("sha256").update(s, "utf8").digest("base64");
      assert.ok(csp.includes(`'sha256-${hash}'`), "CSP allows each inline script");
    }
    assert.match(csp, /connect-src 'none'/);
  });
}
