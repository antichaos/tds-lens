// Calc Lens - page logic. Everything happens locally; files are never uploaded.
import { readDefinition } from "./parse.js";
import { GROUPS, RULES, SEVERITIES, analyzeCalcs, calcsToJSON, parseCalcModel, renderCalcCsv, renderCalcMarkdown } from "./calcs.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const state = { result: null, fileName: "", prio: "all", ds: "", search: "", showAll: false };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function openFile(file) {
  try {
    showError("");
    const bytes = new Uint8Array(await file.arrayBuffer());
    // in a .twbx the workbook is what we want, even when it also packages a .tds
    const xml = await readDefinition(bytes, file.name, globalThis.JSZip, [".twb", ".tds"]);
    state.result = analyzeCalcs(parseCalcModel(xml));
    state.fileName = file.name;
    state.prio = "all";
    state.ds = "";
    state.search = "";
    $("search").value = "";
    show();
  } catch (err) {
    console.error(err);
    const msg = /zip|central directory|signature/i.test(err.message)
      ? "This file could not be unzipped. Is it a valid .twbx or .tdsx?"
      : err.message || "This file could not be read.";
    showError(`Could not open ${file.name}: ${msg}`);
    if (!state.result) showIntro();
  }
}

function showError(msg) {
  for (const id of ["error", "error2"]) {
    $(id).textContent = msg;
    $(id).hidden = !msg;
  }
}

function showIntro() {
  $("intro").hidden = false;
  $("result").hidden = true;
  $("fileBar").hidden = true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const baseName = (name) => name.replace(/\.(tdsx?|twbx?)$/i, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sevPill = (s, label = s) => `<span class="pill sev-${s}">${esc(label)}</span>`;

function rulesHtml() {
  const rows = GROUPS.flatMap((g) => RULES.filter((r) => r.group === g).map((r, i) =>
    `<tr${i === 0 ? ' class="first"' : ""}><td>${i === 0 ? esc(g) : ""}</td><td><strong>${esc(r.title)}</strong><div class="muted small">${esc(r.why)}</div></td>` +
    `<td class="nowrap">${r.severity.split(" / ").map((s) => sevPill(s)).join(" ")}</td></tr>`));
  return `<div class="table-wrap"><table class="rules-table"><thead><tr><th>Group</th><th>Rule</th><th>Severity</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` +
    `<p class="muted small">Priority starts at the highest severity. It goes one level up when the calculation is used in 3 or more sheets, as a filter, or in a data source filter, and is at most low when no sheet uses it.</p>`;
}

/** Formula with the functions behind the findings marked. */
function formulaHtml(c) {
  let h = esc(c.displayFormula);
  if (c.highlight.length) {
    const re = new RegExp(`\\b(${c.highlight.join("|")})(?=\\s*\\()`, "gi");
    h = h.replace(re, "<mark>$1</mark>");
  }
  return h.replace(/\{(\s*)(FIXED|INCLUDE|EXCLUDE)\b/gi, "{$1<mark>$2</mark>");
}

function calcLink(key) {
  const c = state.result.calcs.find((x) => x.key === key);
  return c ? `<button class="link" type="button" data-goto="${esc(key)}">${esc(c.caption)}</button>` : "";
}

function usageHtml(c) {
  const rows = [];
  const u = c.usage;
  if (c.used === null) {
    rows.push(["Used in", `<span class="muted">Unknown: a data source file has no sheets. Open a workbook that uses it to see usage.</span>`]);
  } else {
    const where = [];
    if (u.sheets.length) where.push(u.sheets.map(esc).join(", "));
    if (u.dsFilter) where.push(`<span class="pill warn">data source filter</span> every sheet`);
    rows.push(["Used in", where.join("; ") || `<span class="muted">${c.published ? "No sheet (defined in the published data source)" : "No sheet"}</span>`]);
    if (u.indirect.length) rows.push(["Via other calculations", u.indirect.map(esc).join(", ")]);
    if (u.filters.length) rows.push(["Filter on", u.filters.map(esc).join(", ")]);
    if (u.dashboards.length) rows.push(["Dashboards", u.dashboards.map(esc).join(", ")]);
  }
  if (c.deps.length) rows.push(["Uses", c.deps.map(calcLink).join(", ")]);
  if (c.dependents.length) rows.push(["Used by", c.dependents.map(calcLink).join(", ")]);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function calcCard(c, i) {
  const meta = [c.dsCaption, c.datatype, c.role, c.isTableCalc ? "table calculation" : "", c.hidden ? "hidden" : "",
    c.adhoc ? `ad-hoc in ${c.adhoc}` : "", c.published ? "published data source" : ""].filter(Boolean).map(esc).join(" · ");
  const findings = c.findings.map((f) =>
    `<li><div class="finding-head">${sevPill(f.severity)}<span class="kw">${esc(f.group)}</span><strong>${esc(f.title)}</strong></div>` +
    `<div class="muted small">${esc(f.why)}</div></li>`).join("");
  const long = c.displayFormula.split("\n").length > 14 || c.displayFormula.length > 900;
  const formula = `<pre class="sql formula">${formulaHtml(c)}</pre>`;
  return `<article class="card calc prio-${c.priority}" id="calc-${i}" data-key="${esc(c.key)}">` +
    `<header class="card-head">${sevPill(c.priority, c.priority === "none" ? "no findings" : `${c.priority} priority`)}<h3>${esc(c.caption)}</h3>` +
    `<span class="eyebrow">${meta}</span></header>` +
    (findings ? `<ul class="checklist">${findings}</ul>` : "") +
    (long ? `<details class="notes"><summary>Formula (${c.displayFormula.split("\n").length} lines)</summary>${formula}</details>` : `<h4>Formula</h4>${formula}`) +
    `<h4>Usage</h4>${usageHtml(c)}</article>`;
}

function visible() {
  const { calcs } = state.result;
  const min = state.prio === "all" ? 1 : SEVERITIES.indexOf(state.prio);
  const q = state.search.trim().toLowerCase();
  return calcs.filter((c) =>
    (SEVERITIES.indexOf(c.priority) >= min || (state.showAll && c.priority === "none")) &&
    (!state.ds || c.ds === state.ds) &&
    (!q || c.caption.toLowerCase().includes(q) || c.displayFormula.toLowerCase().includes(q)));
}

function renderList() {
  const { calcs } = state.result;
  for (const b of document.querySelectorAll("[data-prio]")) b.classList.toggle("active", b.dataset.prio === state.prio);
  const list = visible();
  const hidden = calcs.length - list.length;
  $("calcList").innerHTML = (list.length
    ? list.map((c) => calcCard(c, calcs.indexOf(c))).join("")
    : `<section class="card"><p class="muted">${calcs.length ? "No calculations match these filters." : "This file has no calculated fields."}</p></section>`) +
    (hidden && list.length ? `<p class="muted small center">${plural(hidden, "more calculation")} hidden by the filters above.</p>` : "");
}

function show() {
  const { summary: s } = state.result;
  $("intro").hidden = true;
  $("result").hidden = false;
  $("fileBar").hidden = false;
  $("fileName").textContent = state.fileName;
  const title = baseName(state.fileName);
  document.title = `${title} · Calc Lens`;
  $("wbTitle").textContent = title;
  $("wbMeta").textContent = s.kind === "workbook"
    ? `Workbook · ${plural(s.datasources, "data source")} · ${plural(s.worksheets, "sheet")} · ${plural(s.dashboards, "dashboard")}`
    : "Data source · usage is only known in a workbook";
  const stats = [["Calculations", s.calculations], ["High", s.high], ["Medium", s.medium], ["Low", s.low]];
  if (s.kind === "workbook") stats.push(["Unused", s.unused]);
  $("wbStats").innerHTML = stats.map(([k, v]) => `<div class="stat-${k.toLowerCase()}"><dt>${k}</dt><dd>${v}</dd></div>`).join("");

  const dss = [...new Map(state.result.calcs.map((c) => [c.ds, c.dsCaption])).entries()];
  $("dsFilter").hidden = dss.length < 2;
  $("dsFilter").innerHTML = `<option value="">All data sources</option>` + dss.map(([n, cap]) => `<option value="${esc(n)}">${esc(cap)}</option>`).join("");
  renderList();
}

function goto(key) {
  const c = state.result.calcs.find((x) => x.key === key);
  if (!c) return;
  if (!visible().includes(c)) { // make sure it is in the list
    state.prio = "all"; state.ds = ""; state.search = ""; state.showAll = true;
    $("search").value = ""; $("showAll").checked = true; $("dsFilter").value = "";
    renderList();
  }
  const el = $(`calc-${state.result.calcs.indexOf(c)}`);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

const slug = (s) => (s.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_").slice(0, 80)) || "workbook";

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function download(kind) {
  const title = baseName(state.fileName);
  const base = `${slug(title)}_calculations`;
  const blob = (s, type) => new Blob([s], { type: `${type};charset=utf-8` });
  if (kind === "md") save(blob(renderCalcMarkdown(state.result, title), "text/markdown"), `${base}.md`);
  // BOM so Excel reads UTF-8
  else if (kind === "csv") save(blob(`﻿${renderCalcCsv(state.result)}`, "text/csv"), `${base}.csv`);
  else if (kind === "json") save(blob(JSON.stringify(calcsToJSON(state.result), null, 2), "application/json"), `${base}.json`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  for (const el of document.querySelectorAll(".rules")) el.innerHTML = rulesHtml();
  $("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = "";
  });
  $("openAnother").addEventListener("click", () => $("fileInput").click());
  $("trySample").addEventListener("click", async () => {
    try {
      // the single-file (offline) build embeds the sample; the website fetches it
      const blob = globalThis.CALC_LENS_SAMPLE
        ? new Blob([globalThis.CALC_LENS_SAMPLE], { type: "text/xml" })
        : await (await fetch("samples/superstore_calcs.twb")).blob();
      openFile(new File([blob], "superstore_calcs.twb"));
    } catch {
      showError("The sample could not be loaded.");
    }
  });

  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
  });

  document.querySelector(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-prio]");
    if (!b) return;
    state.prio = b.dataset.prio;
    renderList();
  });
  $("dsFilter").addEventListener("change", (e) => { state.ds = e.target.value; renderList(); });
  $("search").addEventListener("input", (e) => { state.search = e.target.value; renderList(); });
  $("showAll").addEventListener("change", (e) => { state.showAll = e.target.checked; renderList(); });
  $("calcList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (b) goto(b.dataset.goto);
  });
  $("showRules").addEventListener("click", (e) => {
    e.preventDefault();
    $("rulesResult").open = true;
    $("rulesResult").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelector(".downloads").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) download(b.dataset.dl);
  });
}

init();
