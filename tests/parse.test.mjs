// Parity tests: the JavaScript parser must produce exactly the same model as
// tds_structure.py --format json. Fixtures: tests/fixtures (committed, synthetic)
// plus samples/private (local real-world files, gitignored) when present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { parseXml, readDefinition, toJSON, displayName } from "../web/js/parse.js";
import { layout } from "../web/js/diagram.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [join(root, "tests/fixtures"), join(root, "samples/private")].filter(existsSync);
const fixtures = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(tds|twb)$/i.test(f)).map((f) => join(d, f)));

const python = (file) => {
  const out = JSON.parse(execFileSync("python3", [join(root, "tds_structure.py"), file, "-f", "json"], { maxBuffer: 1 << 28 }));
  return Array.isArray(out) ? out : [out];
};

for (const file of fixtures) {
  test(`parity with Python: ${file.replace(root + "/", "")}`, () => {
    const js = parseXml(readFileSync(file, "utf8"), DOMParser).map(toJSON);
    const py = python(file);
    assert.equal(js.length, py.length);
    js.forEach((ds, i) => assert.deepEqual(ds, py[i]));
  });

  test(`diagram layout places every table: ${file.replace(root + "/", "")}`, () => {
    for (const ds of parseXml(readFileSync(file, "utf8"), DOMParser)) {
      const { pos } = layout(ds);
      assert.equal(Object.keys(pos).length, ds.tables.length);
    }
  });
}

test("reads .tds inside a .tdsx zip", async () => {
  const zip = new JSZip();
  zip.file("Data/Extracts/x.hyper", "binary");
  zip.file("superstore.tds", readFileSync(join(root, "tests/fixtures/superstore_sample.tds")));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const xml = await readDefinition(bytes, "x.tdsx", JSZip);
  const [ds] = parseXml(xml, DOMParser);
  assert.equal(ds.caption, "Superstore Sample");
  assert.equal(ds.relationships.length, 1);
});

test("rejects non-Tableau XML", () => {
  assert.throws(() => parseXml("<html><body/></html>", DOMParser), /not a Tableau/);
});

test("display name expands Tableau's 30-char truncation", () => {
  const t = {
    caption: "DAP_VOERTUIG_GEGEVENS_VAN_HET_",
    physical: { kind: "table", name: "DAP_VOERTUIG_GEGEVENS_VAN_HET_", table: "[S].[DAP_VOERTUIG_GEGEVENS_VAN_HET_CONTRACT]", children: [] },
  };
  assert.equal(displayName(t), "DAP_VOERTUIG_GEGEVENS_VAN_HET_CONTRACT");
});
