// Checks and comparison, on synthetic fixtures (so they also run in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import { parseXml } from "../web/js/parse.js";
import { runChecks, lastWord } from "../web/js/checks.js";
import { compareDatasources } from "../web/js/compare.js";
import { renderMarkdown, compareMarkdown } from "../web/js/report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = readFileSync(join(root, "web/samples/superstore_sample.tds"), "utf8");
const parse = (xml) => parseXml(xml, DOMParser)[0];

test("lastWord recognises name and key suffixes", () => {
  assert.equal(lastWord("Accountnaam"), "naam");
  assert.equal(lastWord("AccountID"), "id");
  assert.equal(lastWord("BrancheFK"), "fk");
  assert.equal(lastWord("customer_name"), "name");
  assert.equal(lastWord("Contractnummer"), "nummer");
  assert.equal(lastWord("Region (People)"), "region");
});

test("checks on the sample: defaults, custom SQL, initial SQL, filters", () => {
  const codes = runChecks(parse(SAMPLE)).map((c) => c.code);
  for (const c of ["default-performance-options", "custom-sql", "initial-sql", "data-source-filters"]) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes("name-vs-id"));
  assert.ok(!codes.includes("personal-login"), "tableau_reader is a service-style login");
});

test("checks flag a name joined to an ID, a type mismatch and a personal login", () => {
  const xml = SAMPLE
    .replace("<expression op='[customer_id]' /><expression op='[customer_id (customers)]' />",
      "<expression op='[customer_name]' /><expression op='[customer_id (customers)]' />")
    .replace("<local-name>[quantity]</local-name><parent-name>[orders]</parent-name><local-type>integer",
      "<local-name>[quantity]</local-name><parent-name>[orders]</parent-name><local-type>integer")
    .replace("<expression op='[product_id]' />", "<expression op='[quantity]' />")
    .replace("username='tableau_reader'", "username='jan.jansen'");
  const checks = runChecks(parse(xml));
  const codes = checks.map((c) => c.code);
  assert.ok(codes.includes("name-vs-id"), "customer_name = customer_id");
  assert.ok(codes.includes("type-mismatch"), "quantity (integer) = product_id (string)");
  assert.ok(codes.includes("personal-login"));
  assert.equal(checks[0].severity, "warning", "warnings come first");
  const nv = checks.find((c) => c.code === "name-vs-id");
  assert.deepEqual(nv.targets, [{ rel: 0 }]);
});

test("comparing a file with itself finds nothing", () => {
  assert.deepEqual(compareDatasources(parse(SAMPLE), parse(SAMPLE)).changes, []);
});

test("comparison ignores schema but reports real changes", () => {
  const b = SAMPLE
    .replaceAll("[public].[", "[prod].[")                                  // other schema: not a change
    .replace("server='db.example.com'", "server='db-prod.example.com'")     // connection change
    .replace("<second-end-point object-id='Shipping_Modes_0A1B2C'  />",
      "<second-end-point object-id='Shipping_Modes_0A1B2C' unique-key='true' />")  // cardinality change
    .replace("<filter class='categorical' column='[segment]' />", "");      // filter removed
  const { changes, marks } = compareDatasources(parse(SAMPLE), parse(b));
  const items = changes.map((c) => `${c.section}|${c.kind}|${c.item}`);
  assert.ok(items.includes("Connections|changed|Server"));
  assert.ok(items.includes("Relationships|changed|Orders – Shipping Modes: cardinality"), items.join("\n"));
  assert.ok(items.includes("Filters|changed|Data source filters"));
  assert.ok(!items.some((i) => i.includes("physical layer")), "schema change alone is not a table change");
  assert.ok(Object.values(marks.rels).includes("changed"));
});

test("comparison finds added and removed tables and relationships", () => {
  const b = SAMPLE
    .replace(/<object caption='Shipping Modes'[\s\S]*?<\/object>/, "")
    .replace(/<relationship><expression op='='><expression op='\[ship_mode\]' \/>[\s\S]*?<\/relationship>/, "");
  const { changes } = compareDatasources(parse(SAMPLE), parse(b));
  const items = changes.map((c) => `${c.section}|${c.kind}|${c.item}`);
  assert.ok(items.includes("Tables|removed|Shipping Modes"));
  assert.ok(items.some((i) => i.startsWith("Relationships|removed|")));
  const back = compareDatasources(parse(b), parse(SAMPLE)).changes.map((c) => `${c.section}|${c.kind}|${c.item}`);
  assert.ok(back.includes("Tables|added|Shipping Modes"));
});

test("markdown documentation contains the essentials", () => {
  const ds = parse(SAMPLE);
  const md = renderMarkdown(ds, runChecks(ds), { imageFile: "x.png" });
  for (const s of ["# Superstore Sales (sample)", "![Relationship diagram](x.png)", "## Connection", "### Relationships (5)",
    "| Orders | Customers |", "## Calculated fields (2)", "Profit Ratio", "## Checks"]) assert.ok(md.includes(s), s);
  const cmd = compareMarkdown(compareDatasources(ds, ds), "A", "B");
  assert.ok(cmd.includes("No differences."));
});
