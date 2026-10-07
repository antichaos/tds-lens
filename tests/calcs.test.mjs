// Calc Lens: formula analysis and the workbook model, on the synthetic sample workbook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { readDefinition } from "../web/js/parse.js";
import {
  analyzeCalcs, analyzeFormula, calcsToJSON, instanceField, parseCalcModel, renderCalcCsv, renderCalcMarkdown, tokenize,
} from "../web/js/calcs.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKBOOK = readFileSync(join(root, "web/samples/superstore_calcs.twb"), "utf8");
const analyze = (xml) => analyzeCalcs(parseCalcModel(xml, DOMParser));
const result = analyze(WORKBOOK);
const calc = (caption) => result.calcs.find((c) => c.caption === caption);
const codes = (caption) => calc(caption).findings.map((f) => f.code);

test("tokenizer: strings, escaped brackets, qualified fields, comments", () => {
  const t = tokenize(`// note [Not A Field]\nIF [a]]b] = 'it''s' THEN [Parameters].[Top N] /* [x] */ END`);
  assert.deepEqual(t.filter((x) => x.t === "field").map((x) => [x.ds, x.v]), [["", "a]b"], ["Parameters", "Top N"]]);
  assert.equal(t.find((x) => x.t === "str").v, "it's");
});

test("formula analysis: branches, string comparisons, LODs, table calcs", () => {
  const a = analyzeFormula(`CASE [Region] WHEN 'N' THEN 1 WHEN 'S' THEN 2 WHEN 'E' THEN 3 END`);
  assert.equal(a.branches, 3);
  assert.equal(a.stringCompares, 3);
  assert.equal(analyzeFormula(`IF [x] IN ('a', 'b', 'c') THEN 1 ELSEIF [y] = "z" THEN 2 END`).stringCompares, 4);

  const lod = analyzeFormula(`{ FIXED [Region], [Customer] : AVG({ INCLUDE [Order] : SUM([Sales]) }) }`);
  assert.deepEqual(lod.lods.map((l) => [l.type, l.dims]), [["FIXED", 2], ["INCLUDE", 1]]);
  assert.equal(lod.lodDepth, 2);
  assert.deepEqual(analyzeFormula(`{ SUM([Sales]) }`).lods.map((l) => l.type), ["TABLE"]);

  const tc = analyzeFormula(`WINDOW_AVG(RUNNING_SUM(SUM([Sales])), -2, 0)`);
  assert.equal(tc.tcDepth, 2);
  assert.deepEqual(tc.tcNested, ["WINDOW_AVG(RUNNING_SUM(…))"]);
  assert.equal(analyzeFormula(`WINDOW_SUM(SUM([a])) / WINDOW_SUM(SUM([b]))`).tcDepth, 1);
});

test("text-to-date: only when the argument really is text", () => {
  const casts = (f) => analyzeFormula(f).dateCasts.map((d) => d.strish);
  assert.deepEqual(casts(`DATE(LEFT([d], 7) + '-01')`), [true]);
  assert.deepEqual(casts(`DATE(DATEADD('month', 1, [d]))`), [false], "a date-part string is not a text date");
  assert.deepEqual(casts(`DATE(DATETRUNC('month', [d]))`), [false]);
});

test("instance names resolve to fields", () => {
  assert.equal(instanceField("[none:Calculation_0002:nk]"), "Calculation_0002");
  assert.equal(instanceField("[pcto:sum:Sales:qk]"), "Sales");
  assert.equal(instanceField("[Sales]"), "Sales");
});

test("workbook model: sheets, dashboards, parameters excluded", () => {
  const s = result.summary;
  assert.equal(s.kind, "workbook");
  assert.equal(s.calculations, 22, "parameters are not calculations");
  assert.equal(s.worksheets, 5);
  assert.equal(s.dashboards, 2);
});

test("string logic findings", () => {
  assert.ok(codes("Order Date").includes("string-to-date"));
  assert.ok(codes("Order Year (old)").includes("string-to-date"));
  assert.ok(codes("Region Group").includes("long-branch"));
  assert.ok(codes("Is Premium Product").includes("regex"));
  assert.ok(!codes("Order Month").includes("string-to-date"), "DATETRUNC('month', …) is not a text cast");
});

test("LOD and table calc findings, through the dependency graph", () => {
  assert.ok(codes("Avg Customer Sales per Region").includes("lod-nested"));
  assert.ok(codes("Customer Sales").includes("lod"));
  assert.ok(codes("Running Sales").includes("table-calc"));
  assert.ok(codes("Running Sales (3-period avg)").includes("table-calc-nested"), "WINDOW_AVG over a RUNNING_SUM calc");
  assert.ok(calc("In Top N").isTableCalc, "a calc on a table calc is a table calc");
  assert.ok(codes("In Top N").includes("table-calc-filter"));
});

test("dependencies: chain depth and inherited cost", () => {
  assert.equal(calc("Margin Band Sort").depth, 5);
  assert.ok(codes("Margin Band Sort").includes("deep-chain"));
  assert.ok(codes("Ship Delay (days)").includes("inherits"));
  assert.deepEqual(calc("Profit Ratio").findings, []);
});

test("usage: direct, indirect, filters, data source filters, unused", () => {
  const rs = calc("Running Sales").usage;
  assert.deepEqual(rs.sheets.sort(), ["Sales Trend", "Sales by Region"].sort());
  assert.deepEqual(rs.dashboards, ["Executive Overview"]);
  assert.deepEqual(calc("Customer Sales").usage.indirect, ["Customer Tiers"], "used through Customer Tier");
  assert.deepEqual(calc("Region Group").usage.filters, ["Sales by Region"]);
  assert.ok(calc("Region Access").usage.dsFilter);
  assert.equal(calc("Order Year (old)").used, false);
  assert.ok(codes("Segment Code").includes("unused"));
  assert.equal(calc("Profit Ratio").used, true);
});

test("priority: usage raises it, unused caps it at low", () => {
  assert.equal(calc("Region Group").severity, "medium");
  assert.equal(calc("Region Group").priority, "high", "used as a filter");
  assert.equal(calc("Order Year (old)").severity, "high");
  assert.equal(calc("Order Year (old)").priority, "low", "nobody uses it");
  assert.equal(calc("Segment Code").priority, "low");
  assert.equal(result.calcs[0].priority, "high", "sorted most urgent first");
});

test("data source file: findings without usage", () => {
  const r = analyze(readFileSync(join(root, "web/samples/superstore_sample.tds"), "utf8"));
  assert.equal(r.summary.kind, "datasource");
  for (const c of r.calcs) {
    assert.equal(c.used, null);
    assert.ok(!c.findings.some((f) => f.code === "unused"));
  }
});

test(".twbx: the workbook is read even when a .tds is packaged too", async () => {
  const zip = new JSZip();
  zip.file("Data/extra.tds", readFileSync(join(root, "web/samples/superstore_sample.tds")));
  zip.file("superstore_calcs.twb", WORKBOOK);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const xml = await readDefinition(bytes, "x.twbx", JSZip, [".twb", ".tds"]);
  assert.equal(analyze(xml).summary.calculations, 22);
});

test("exports: Markdown, CSV, JSON", () => {
  const md = renderCalcMarkdown(result, "superstore_calcs");
  assert.match(md, /^# Expensive calculations: superstore_calcs/);
  assert.match(md, /\| high \| Region Group \|/);
  assert.match(md, /DATEPARSE\('yyyy-MM-dd', \[Order Date Text\]\)/);
  assert.match(md, /DATETRUNC\('month', \[Order Date\]\)/, "internal names shown as captions");

  const csv = renderCalcCsv(result).trim().split("\r\n");
  assert.equal(csv.length, 23);
  assert.match(csv[0], /^priority,severity,calculation/);

  const json = calcsToJSON(result);
  assert.equal(json.calculations.length, 22);
  assert.deepEqual(json.calculations.find((c) => c.name === "Customer Tier").uses, ["Calculation_0006"]);
});
