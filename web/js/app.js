// TDS Lens - page logic. Everything happens locally; files are never uploaded.
import { dsTitle, parseXml, readDefinition, toJSON } from "./parse.js";
import { renderSvg, svgToPng } from "./diagram.js";
import { runChecks } from "./checks.js";
import { compareDatasources } from "./compare.js";
import {
  checksHtml, compareHtml, compareMarkdown, compareText, esc, relDetail, renderHtml,
  renderMarkdown, renderMermaid, renderText, tableDetail,
} from "./report.js";

const $ = (id) => document.getElementById(id);
const state = {
  datasources: [], current: 0, fileName: "", zoom: 1, edgeLabels: false, selected: null,
  checks: [],
  compare: null, // { a: {ds, name}, b: {ds, name}, result }
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const xml = await readDefinition(bytes, file.name);
  const list = parseXml(xml);
  if (!list.length) throw new Error("No data sources found in this file.");
  return list;
}

function friendly(err, file) {
  console.error(err);
  const msg = /zip|central directory|signature/i.test(err.message)
    ? "This file could not be unzipped. Is it a valid .tdsx or .twbx?"
    : err.message || "This file could not be read.";
  return `Could not open ${file.name}: ${msg}`;
}

const baseName = (name) => name.replace(/\.(tdsx?|twbx?)$/i, "");
const titleOf = (ds, fileName) => dsTitle(ds, baseName(fileName));

async function openFile(file) {
  try {
    showError("");
    state.datasources = await load(file);
    state.fileName = file.name;
    state.current = 0;
    state.selected = null;
    state.compare = null;
    show();
  } catch (err) {
    showError(friendly(err, file));
    if (!state.datasources.length) showIntro();
  }
}

/** Compare the open data source (A) with one from another file (B). */
async function openCompare(fileB, fileA = null) {
  try {
    showError("");
    if (fileA) {
      state.datasources = await load(fileA);
      state.fileName = fileA.name;
      state.current = 0;
    }
    const listB = await load(fileB);
    const a = state.datasources[state.current];
    // in a workbook, prefer the data source with the same name
    const b = listB.find((d) => d.caption.trim() === a.caption.trim()) || listB.find((d) => d.name === a.name) || listB[0];
    const nameA = `${titleOf(a, state.fileName)} (${state.fileName})`;
    const nameB = `${titleOf(b, fileB.name)} (${fileB.name})`;
    setCompare({ ds: a, name: nameA }, { ds: b, name: nameB });
  } catch (err) {
    showError(friendly(err, fileB));
    if (!state.datasources.length) showIntro();
  }
}

function setCompare(a, b) {
  state.compare = { a, b, result: compareDatasources(a.ds, b.ds) };
  state.selected = null;
  show();
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

/** The data source drawn in the diagram: the open one, or B when comparing. */
const ds = () => (state.compare ? state.compare.b.ds : state.datasources[state.current]);

function show() {
  $("intro").hidden = true;
  $("result").hidden = false;
  $("fileBar").hidden = false;
  const cmp = state.compare;
  $("fileName").textContent = cmp ? `${state.fileName} ↔ ${cmp.b.name.replace(/^.*\((.*)\)$/, "$1")}` : state.fileName;

  const tabs = $("tabs");
  tabs.hidden = cmp || state.datasources.length < 2;
  tabs.innerHTML = state.datasources.map((d, i) =>
    `<button class="tab" role="tab" aria-selected="${i === state.current}" data-i="${i}">${esc(titleOf(d, state.fileName) || d.name)}</button>`).join("");

  $("compareBar").hidden = !cmp;
  $("compareBtn").hidden = !!cmp;
  for (const el of document.querySelectorAll("[data-mode]")) el.hidden = el.dataset.mode !== (cmp ? "compare" : "single");

  const d = ds();
  if (cmp) {
    const n = cmp.result.changes.length;
    document.title = `Comparison · TDS Lens`;
    $("dsTitle").textContent = n ? `${n} difference${n === 1 ? "" : "s"}` : "No differences";
    $("dsModel").innerHTML = `<span class="pill a">A</span> ${esc(cmp.a.name)}<br><span class="pill b">B</span> ${esc(cmp.b.name)}`;
    const count = (k) => cmp.result.changes.filter((c) => c.kind === k).length;
    $("dsStats").innerHTML = [["Added", count("added")], ["Removed", count("removed")], ["Changed", count("changed")]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    $("diagramNote").textContent = "The diagram shows B. Green = added in B, orange = changed. Removed items are listed below.";
    $("report").innerHTML = compareHtml(cmp.result, "A", "B");
  } else {
    state.checks = runChecks(d);
    const title = titleOf(d, state.fileName);
    document.title = `${title} · TDS Lens`;
    $("dsTitle").textContent = title;
    const live = d.extract && d.extract.enabled === "true" ? "Extract" : "Live";
    $("dsModel").textContent = `${d.model || "Unknown model"} · ${live}${d.version ? ` · file version ${d.version}` : ""}`;
    $("dsStats").innerHTML = [
      ["Connections", d.connections.length], ["Tables", d.tables.length],
      ["Relationships", d.relationships.length], ["Calculated fields", d.calculated_fields],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    $("diagramNote").textContent = "Click a table or a line for details. Hover for a quick summary.";
    $("report").innerHTML = checksHtml(state.checks) + renderHtml(d);
  }
  closePanel();
  drawDiagram(true);
}

function svgFor(d) {
  const cmp = state.compare;
  return renderSvg(d, {
    edgeLabels: state.edgeLabels,
    marks: cmp ? cmp.result.marks : null,
    titleText: cmp ? `B: ${cmp.b.name}` : titleOf(d, state.fileName),
  });
}

function drawDiagram(fit = false) {
  const canvas = $("canvas");
  if (!ds().tables.length) {
    canvas.innerHTML = `<p class="muted" style="padding:16px">This data source has no tables to draw.</p>`;
    return;
  }
  canvas.innerHTML = svgFor(ds());
  const svg = canvas.querySelector("svg");
  svg.dataset.w = svg.getAttribute("width");
  svg.dataset.h = svg.getAttribute("height");
  if (fit) state.zoom = fitZoom();
  applyZoom();
  if (state.selected) highlight(state.selected);
}

function fitZoom() {
  const svg = $("canvas").querySelector("svg");
  if (!svg) return 1;
  const avail = $("canvas").clientWidth - 2;
  return Math.max(0.25, Math.min(1, avail / Number(svg.dataset.w)));
}

function applyZoom() {
  const svg = $("canvas").querySelector("svg");
  if (!svg) return;
  svg.setAttribute("width", Math.round(Number(svg.dataset.w) * state.zoom));
  svg.setAttribute("height", Math.round(Number(svg.dataset.h) * state.zoom));
  $("zoom100").textContent = `${Math.round(state.zoom * 100)}%`;
}

// ---------------------------------------------------------------------------
// Selection, highlighting, detail panel
// ---------------------------------------------------------------------------

function highlight(sel) {
  const canvas = $("canvas");
  canvas.querySelectorAll(".hl, .sel").forEach((el) => el.classList.remove("hl", "sel"));
  if (!sel) return;
  const targets = sel.targets || [sel];
  for (const t of targets) {
    if (t.table !== undefined) {
      canvas.querySelector(`g.tbl[data-table="${CSS.escape(t.table)}"]`)?.classList.add("sel");
      if (!sel.targets) {
        canvas.querySelectorAll("g.rel").forEach((g) => {
          if (g.dataset.a === t.table || g.dataset.b === t.table) g.classList.add("hl");
        });
      }
    } else if (t.rel !== undefined) {
      const g = canvas.querySelector(`g.rel[data-rel="${t.rel}"]`);
      if (g) {
        g.classList.add("hl");
        for (const id of [g.dataset.a, g.dataset.b]) canvas.querySelector(`g.tbl[data-table="${CSS.escape(id)}"]`)?.classList.add("hl");
      }
    }
  }
}

function select(sel, { scroll = false } = {}) {
  state.selected = sel;
  if (sel.targets) { // a check: highlight all its tables / relationships
    closePanel();
    state.selected = sel;
  } else {
    $("panelBody").innerHTML = sel.table !== undefined ? tableDetail(ds(), sel.table) : relDetail(ds(), sel.rel);
    $("panel").hidden = false;
    $("stage").classList.add("with-panel");
  }
  highlight(sel);
  if (scroll) {
    $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
    const first = (sel.targets || [sel])[0];
    const el = first && (first.table !== undefined
      ? $("canvas").querySelector(`g.tbl[data-table="${CSS.escape(first.table)}"]`)
      : $("canvas").querySelector(`g.rel[data-rel="${first.rel}"]`));
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }
}

function closePanel() {
  state.selected = null;
  $("panel").hidden = true;
  $("stage").classList.remove("with-panel");
  highlight(null);
}

function selectionFrom(target) {
  const c = target.closest("[data-check]");
  if (c) return { targets: state.checks[Number(c.dataset.check)].targets };
  const t = target.closest("[data-table]");
  if (t) return { table: t.dataset.table };
  const r = target.closest("[data-rel]");
  if (r) return { rel: Number(r.dataset.rel) };
  return null;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function slug(s) {
  return (s.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_").slice(0, 80)) || "datasource";
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const text = (s, type = "text/plain") => new Blob([s], { type: `${type};charset=utf-8` });

async function download(kind) {
  const d = ds();
  const cmp = state.compare;
  if (cmp) {
    const base = `comparison_${slug(titleOf(cmp.a.ds, state.fileName))}`;
    if (kind === "svg") save(text(svgFor(d), "image/svg+xml"), `${base}.svg`);
    else if (kind === "png") save(await svgToPng(svgFor(d)), `${base}.png`);
    else if (kind === "txt") save(text(compareText(cmp.result, cmp.a.name, cmp.b.name)), `${base}.txt`);
    else if (kind === "md") save(text(compareMarkdown(cmp.result, cmp.a.name, cmp.b.name), "text/markdown"), `${base}.md`);
    else if (kind === "json") save(text(JSON.stringify({ a: cmp.a.name, b: cmp.b.name, changes: cmp.result.changes }, null, 2), "application/json"), `${base}.json`);
    return;
  }
  const title = titleOf(d, state.fileName);
  const base = slug(title);
  if (kind === "svg") save(text(svgFor(d), "image/svg+xml"), `${base}.svg`);
  else if (kind === "png") save(await svgToPng(svgFor(d)), `${base}.png`);
  else if (kind === "txt") save(text(renderText(d, state.checks, title)), `${base}.txt`);
  else if (kind === "md") save(text(renderMarkdown(d, state.checks, { title, imageFile: `${base}.png` }), "text/markdown"), `${base}.md`);
  else if (kind === "mmd") save(text(renderMermaid(d)), `${base}.mmd`);
  else if (kind === "json") save(text(JSON.stringify({ ...toJSON(d), checks: state.checks }, null, 2), "application/json"), `${base}.json`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function handleFiles(files) {
  files = [...files].filter(Boolean);
  if (files.length >= 2) openCompare(files[1], files[0]);
  else if (files.length === 1) {
    // dropping a file while viewing one: open it (use "Compare with…" to compare)
    openFile(files[0]);
  }
}

function init() {
  $("fileInput").addEventListener("change", (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  });
  $("compareInput").addEventListener("change", (e) => {
    if (e.target.files[0]) openCompare(e.target.files[0]);
    e.target.value = "";
  });
  $("openAnother").addEventListener("click", () => $("fileInput").click());
  $("compareBtn").addEventListener("click", () => $("compareInput").click());
  $("swapCompare").addEventListener("click", () => {
    const { a, b } = state.compare;
    setCompare(b, a);
  });
  $("stopCompare").addEventListener("click", () => {
    const a = state.compare.a.ds;
    state.compare = null;
    state.current = Math.max(0, state.datasources.indexOf(a));
    show();
  });
  $("trySample").addEventListener("click", async () => {
    try {
      // the single-file (offline) build embeds the sample; the website fetches it
      const blob = globalThis.TDS_LENS_SAMPLE
        ? new Blob([globalThis.TDS_LENS_SAMPLE], { type: "text/xml" })
        : await (await fetch("samples/superstore_sample.tds")).blob();
      openFile(new File([blob], "superstore_sample.tds"));
    } catch {
      showError("The sample could not be loaded.");
    }
  });

  // drag & drop anywhere on the page (two files = compare)
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    handleFiles(e.dataTransfer.files);
  });

  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (!b) return;
    state.current = Number(b.dataset.i);
    state.selected = null;
    show();
  });

  $("zoomIn").addEventListener("click", () => { state.zoom = Math.min(3, state.zoom * 1.25); applyZoom(); });
  $("zoomOut").addEventListener("click", () => { state.zoom = Math.max(0.2, state.zoom / 1.25); applyZoom(); });
  $("zoom100").addEventListener("click", () => { state.zoom = 1; applyZoom(); });
  $("zoomFit").addEventListener("click", () => { state.zoom = fitZoom(); applyZoom(); });
  $("edgeLabels").addEventListener("change", (e) => { state.edgeLabels = e.target.checked; drawDiagram(true); });

  document.querySelector(".downloads").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) download(b.dataset.dl).catch((err) => showError(err.message));
  });

  // diagram: click to select, hover table to highlight its relationships
  $("canvas").addEventListener("click", (e) => {
    const sel = selectionFrom(e.target);
    if (sel) select(sel);
    else closePanel();
  });
  $("canvas").addEventListener("mouseover", (e) => {
    if (state.selected) return;
    const t = e.target.closest("g.tbl");
    highlight(t ? { table: t.dataset.table } : null);
  });
  $("canvas").addEventListener("mouseleave", () => { if (!state.selected) highlight(null); });

  // panel and report links
  $("panel").addEventListener("click", (e) => {
    if (e.target.closest("#closePanel")) return closePanel();
    const sel = selectionFrom(e.target);
    if (sel) select(sel);
  });
  $("report").addEventListener("click", (e) => {
    if (e.target.closest("summary")) return;
    const sel = selectionFrom(e.target);
    if (sel) select(sel, { scroll: true });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected) closePanel(); });
}

init();
