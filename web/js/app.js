// TDS Lens - page logic. Everything happens locally; files are never uploaded.
import { parseXml, readDefinition, toJSON } from "./parse.js";
import { renderSvg, svgToPng } from "./diagram.js";
import { esc, relDetail, renderHtml, renderMermaid, renderText, tableDetail } from "./report.js";

const $ = (id) => document.getElementById(id);
const state = { datasources: [], current: 0, fileName: "", zoom: 1, edgeLabels: false, selected: null };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function openFile(file) {
  try {
    showError("");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const xml = await readDefinition(bytes, file.name);
    const list = parseXml(xml);
    if (!list.length) throw new Error("No data sources found in this file.");
    state.datasources = list;
    state.fileName = file.name;
    state.current = 0;
    state.selected = null;
    show();
  } catch (err) {
    console.error(err);
    const msg = /zip|central directory|signature/i.test(err.message)
      ? "This file could not be unzipped. Is it a valid .tdsx or .twbx?"
      : err.message || "This file could not be read.";
    showError(`Could not open ${file.name}: ${msg}`);
    showIntro();
  }
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

function showIntro() {
  $("intro").hidden = false;
  $("result").hidden = true;
  $("fileBar").hidden = true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ds = () => state.datasources[state.current];

function show() {
  $("intro").hidden = true;
  $("result").hidden = false;
  $("fileBar").hidden = false;
  $("fileName").textContent = state.fileName;

  const tabs = $("tabs");
  tabs.hidden = state.datasources.length < 2;
  tabs.innerHTML = state.datasources.map((d, i) =>
    `<button class="tab" role="tab" aria-selected="${i === state.current}" data-i="${i}">${esc(d.caption.trim() || d.name)}</button>`).join("");

  const d = ds();
  document.title = `${d.caption.trim()} · TDS Lens`;
  $("dsTitle").textContent = d.caption.trim();
  const live = d.extract && d.extract.enabled === "true" ? "Extract" : "Live";
  $("dsModel").textContent = `${d.model || "Unknown model"} · ${live}${d.version ? ` · file version ${d.version}` : ""}`;
  $("dsStats").innerHTML = [
    ["Connections", d.connections.length], ["Tables", d.tables.length],
    ["Relationships", d.relationships.length], ["Calculated fields", d.calculated_fields],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");

  $("report").innerHTML = renderHtml(d);
  closePanel();
  drawDiagram(true);
}

function drawDiagram(fit = false) {
  const canvas = $("canvas");
  if (!ds().tables.length) {
    canvas.innerHTML = `<p class="muted" style="padding:16px">This data source has no tables to draw.</p>`;
    return;
  }
  canvas.innerHTML = renderSvg(ds(), { edgeLabels: state.edgeLabels });
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
  if (sel.table) {
    canvas.querySelector(`g.tbl[data-table="${CSS.escape(sel.table)}"]`)?.classList.add("sel");
    canvas.querySelectorAll("g.rel").forEach((g) => {
      if (g.dataset.a === sel.table || g.dataset.b === sel.table) g.classList.add("hl");
    });
  } else if (sel.rel !== undefined) {
    const g = canvas.querySelector(`g.rel[data-rel="${sel.rel}"]`);
    if (g) {
      g.classList.add("hl");
      for (const id of [g.dataset.a, g.dataset.b]) canvas.querySelector(`g.tbl[data-table="${CSS.escape(id)}"]`)?.classList.add("hl");
    }
  }
}

function select(sel, { scroll = false } = {}) {
  state.selected = sel;
  $("panelBody").innerHTML = sel.table ? tableDetail(ds(), sel.table) : relDetail(ds(), sel.rel);
  $("panel").hidden = false;
  $("stage").classList.add("with-panel");
  highlight(sel);
  if (scroll) {
    $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
    const el = sel.table
      ? $("canvas").querySelector(`g.tbl[data-table="${CSS.escape(sel.table)}"]`)
      : $("canvas").querySelector(`g.rel[data-rel="${sel.rel}"]`);
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

async function download(kind) {
  const d = ds();
  const base = slug(d.caption);
  const svg = () => renderSvg(d, { edgeLabels: state.edgeLabels });
  if (kind === "svg") save(new Blob([svg()], { type: "image/svg+xml" }), `${base}.svg`);
  else if (kind === "png") save(await svgToPng(svg()), `${base}.png`);
  else if (kind === "txt") save(new Blob([renderText(d)], { type: "text/plain" }), `${base}.txt`);
  else if (kind === "mmd") save(new Blob([renderMermaid(d)], { type: "text/plain" }), `${base}.mmd`);
  else if (kind === "json") save(new Blob([JSON.stringify(toJSON(d), null, 2)], { type: "application/json" }), `${base}.json`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  $("fileInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) openFile(f);
    e.target.value = "";
  });
  $("openAnother").addEventListener("click", () => $("fileInput").click());
  $("trySample").addEventListener("click", async () => {
    try {
      const res = await fetch("samples/superstore_sample.tds");
      const blob = await res.blob();
      openFile(new File([blob], "superstore_sample.tds"));
    } catch {
      showError("The sample could not be loaded.");
    }
  });

  // drag & drop anywhere on the page
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
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
    const sel = selectionFrom(e.target);
    if (sel) select(sel, { scroll: true });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.selected) closePanel(); });
}

init();
