// TDS Lens - Tableau-style relationship diagram (logical layer canvas) as SVG.
// Port of diagram_layout / render_svg in tds_structure.py.
import { displayName, leafConnections, physicalTableNames, readable, simpleTable, unqualify } from "./parse.js";

const BOX_W = 200, BOX_H = 28, ROW_H = 40, COL_GAP = 40, MARGIN = 20, ROOT_RAIL = 20, RAD = 8;
const FONT = "'Benton Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#59a14f", "#b07aa1", "#76b7b2", "#edc948", "#9c755f"];

// --- text measurement: exact in the browser (canvas), estimated elsewhere ------------
let ctx = null;
function textWidth(s, size = 12) {
  if (ctx === null && typeof document !== "undefined") {
    ctx = document.createElement("canvas").getContext("2d") || false;
  }
  if (ctx) {
    ctx.font = `${size}px ${FONT}`;
    return ctx.measureText(s).width;
  }
  let w = 0;
  for (const ch of s) {
    if ("il.,:;|!'I ".includes(ch)) w += 0.3;
    else if ("mwMW".includes(ch)) w += 0.85;
    else if (/[A-Z0-9_#%&]/.test(ch)) w += 0.66;
    else w += 0.54;
  }
  return w * size;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Tree layout like Tableau: base table(s) left, related tables to the right.
 * Multi-fact models with exactly two fact tables use a "bridge": fact A left,
 * shared dimensions in the middle, fact B right.
 */
export function layout(ds) {
  const order = ds.tables.map((t) => t.id);
  const seconds = new Set(ds.relationships.map((r) => r.second.table_id));
  const facts = ds.tables.filter((t) => t.role === "fact").map((t) => t.id);
  const bridge = facts.length === 2 ? facts[1] : null;
  let roots = bridge ? [facts[0]] : facts;
  if (!roots.length) roots = order.filter((i) => !seconds.has(i));
  if (!roots.length) roots = order.slice(0, 1);
  roots = [...roots];

  const adj = Object.fromEntries(order.map((i) => [i, []]));
  ds.relationships.forEach((r, idx) => {
    const a = r.first.table_id, b = r.second.table_id;
    if (a in adj && b in adj) {
      adj[a].push([b, idx]);
      adj[b].push([a, idx]);
    }
  });

  const parent = new Map();
  const children = Object.fromEntries(order.map((i) => [i, []]));
  const treeRels = new Set();
  const depth = {};
  if (bridge) parent.set(bridge, null);

  const bfs = (start) => {
    const queue = [];
    for (const rt of start) {
      if (!parent.has(rt) || rt === bridge) {
        parent.set(rt, null);
        depth[rt] = depth[rt] ?? 0;
        queue.push(rt);
      }
    }
    while (queue.length) {
      const n = queue.shift();
      for (const [m, idx] of adj[n]) {
        if (!parent.has(m)) {
          parent.set(m, n);
          depth[m] = depth[n] + 1;
          children[n].push(m);
          treeRels.add(idx);
          queue.push(m);
        }
      }
    }
  };

  bfs(roots);
  const rows = {};
  let counter = 0;
  const place = (n) => {
    if (!children[n].length) {
      rows[n] = counter++;
    } else {
      const ys = children[n].map(place);
      rows[n] = (ys[0] + ys[ys.length - 1]) / 2;
    }
    return rows[n];
  };
  roots.forEach(place);

  if (bridge) {
    const placed = adj[bridge].map(([m]) => m).filter((m) => m in rows);
    depth[bridge] = Math.max(-1, ...placed.map((m) => depth[m])) + 1;
    if (placed.length) {
      const ys = placed.map((m) => rows[m]);
      rows[bridge] = (Math.min(...ys) + Math.max(...ys)) / 2;
    } else {
      rows[bridge] = counter++;
    }
    for (const [m, idx] of adj[bridge]) if (m in rows) treeRels.add(idx);
    bfs([bridge]);
    children[bridge].forEach(place);
  }

  for (;;) { // disconnected tables / islands
    const rest = order.filter((i) => !parent.has(i));
    if (!rest.length) break;
    roots.push(rest[0]);
    bfs([rest[0]]);
    place(rest[0]);
  }

  const pos = Object.fromEntries(order.map((i) => [i, [depth[i], rows[i]]]));
  const tree = [], cross = [];
  ds.relationships.forEach((r, idx) => (treeRels.has(idx) ? tree : cross).push(idx));
  return { pos, tree, cross, roots, nRows: counter };
}

/** Render the diagram. Elements carry data-table / data-rel for interactivity. */
export function renderSvg(ds, { edgeLabels = false, title = true, marks = null, titleText = null } = {}) {
  // marks: { tables: {id: "added"|"changed"}, rels: {index: "added"|"changed"} } (comparison view)
  const mk = (kind) => (kind ? ` m-${kind}` : "");
  const { pos, tree, cross, roots, nRows } = layout(ds);
  const tables = Object.fromEntries(ds.tables.map((t) => [t.id, t]));
  const names = Object.fromEntries(ds.tables.map((t) => [t.id, displayName(t)]));
  const conns = ds.connCaptions || {};
  const multiRoot = roots.length > 1;
  const facts = ds.tables.filter((t) => t.role === "fact").map((t) => t.id);
  const factColor = facts.length > 2 ? Object.fromEntries(facts.map((f, i) => [f, PALETTE[i % PALETTE.length]])) : {};

  const edgeLabel = (r) => `${unqualify(r.predicate_resolved)}  (${r.first.cardinality[0]}:${r.second.cardinality[0]})`;

  let colGap = COL_GAP;
  if (edgeLabels && ds.relationships.length) {
    colGap = Math.max(COL_GAP, Math.ceil(Math.max(...ds.relationships.map((r) => textWidth(edgeLabel(r), 10)))) + 40);
  }
  // each column is as wide as its longest table name (min. BOX_W), so names are never cut off
  const boxW = {};
  for (const [tid, [c]] of Object.entries(pos)) boxW[c] = Math.max(boxW[c] ?? BOX_W, Math.ceil(textWidth(names[tid])) + 24);
  const top = MARGIN + (title ? 30 : 0);
  const left = MARGIN + (multiRoot ? ROOT_RAIL : 0);
  const nCols = Math.max(0, ...Object.values(pos).map(([c]) => c)) + 1;
  const colX = {};
  let x = left;
  for (let c = 0; c < nCols; c++) {
    colX[c] = x;
    x += (boxW[c] ?? BOX_W) + colGap;
  }
  const bw = (tid) => boxW[pos[tid][0]];
  const boxXY = (tid) => [colX[pos[tid][0]], top + pos[tid][1] * ROW_H];

  const width = Math.max(Math.round(x - colGap + MARGIN),
    title ? Math.ceil(textWidth(titleText ?? ds.caption.trim(), 14)) + 2 * MARGIN + (marks ? 160 : 0) : 0);
  const height = top + Math.max(nRows, 1) * ROW_H - (ROW_H - BOX_H) + MARGIN;

  const S = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}">`,
    "<style>" +
      ".edge{fill:none;stroke:#767676;stroke-width:2}" +
      ".edge.cross{stroke-dasharray:5 4}" +
      ".hit{fill:none;stroke:transparent;stroke-width:12}" +
      "g.rel:hover .edge,g.rel.hl .edge{stroke:#2c7bd6}" +
      ".box{fill:#fff;stroke:#3b3b3b;stroke-width:1}" +
      "g.tbl:hover .box,g.tbl.hl .box{fill:#bdd9f2;stroke:#2c7bd6}" +
      "g.tbl.sel .box{fill:#bdd9f2;stroke:#2c7bd6;stroke-width:2}" +
      ".lbl{font-size:12px;fill:#333}" +
      ".elbl{font-size:10px;fill:#777}" +
      ".title{font-size:14px;fill:#555;font-weight:600}" +
      "g.m-added .box{fill:#e1f3e8;stroke:#1e7a46;stroke-width:2}g.m-changed .box{fill:#fdf0d5;stroke:#b26b00;stroke-width:2}" +
      "g.rel.m-added .edge{stroke:#1e7a46;stroke-width:3}g.rel.m-changed .edge{stroke:#b26b00;stroke-width:3}" +
      ".lgd{font-size:11px;fill:#555}" +
      "</style>",
    `<rect width="100%" height="100%" fill="#fff"/>`,
  ];
  const heading = titleText ?? ds.caption.trim();
  if (title) S.push(`<text class="title" x="${MARGIN}" y="${MARGIN + 12}">${esc(heading)}</text>`);
  if (marks && title) {
    const lx = MARGIN + Math.ceil(textWidth(heading, 14)) + 24;
    S.push(`<rect x="${lx}" y="${MARGIN + 2}" width="12" height="12" fill="#e1f3e8" stroke="#1e7a46" stroke-width="2"/><text class="lgd" x="${lx + 17}" y="${MARGIN + 12}">added</text>` +
      `<rect x="${lx + 70}" y="${MARGIN + 2}" width="12" height="12" fill="#fdf0d5" stroke="#b26b00" stroke-width="2"/><text class="lgd" x="${lx + 87}" y="${MARGIN + 12}">changed</text>`);
  }

  // rail joining multiple base tables (as Tableau does for multi-fact models)
  if (multiRoot) {
    const rx = MARGIN + ROOT_RAIL / 2;
    const ys = roots.map((r) => boxXY(r)[1] + BOX_H / 2).sort((a, b) => a - b);
    S.push(`<path class="edge" d="M${rx},${ys[0]} V${ys[ys.length - 1]}"/>`);
    for (const y of ys) S.push(`<path class="edge" d="M${rx},${y} H${left}"/>`);
  }

  const elbow = (x1, y1, x2, y2, xm) => {
    if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`;
    const r = Math.min(RAD, Math.abs(y2 - y1) / 2, xm - x1, x2 - xm);
    const sgn = y2 > y1 ? 1 : -1;
    return `M${x1},${y1} H${xm - r} Q${xm},${y1} ${xm},${y1 + sgn * r} V${y2 - sgn * r} Q${xm},${y2} ${xm + r},${y2} H${x2}`;
  };

  const relTip = (r) => {
    const f = names[r.first.table_id] ?? r.first.table, s = names[r.second.table_id] ?? r.second.table;
    return `${f} → ${s}\non: ${readable(r.predicate_resolved)}\ncardinality: ${r.first.cardinality} : ${r.second.cardinality}\n` +
      `referential integrity: ${f} = ${r.first.referential_integrity}, ${s} = ${r.second.referential_integrity}`;
  };

  const edges = [...tree.map((i) => [i, false]), ...cross.map((i) => [i, true])].map(([idx, isCross]) => {
    const r = ds.relationships[idx];
    let a = r.first.table_id, b = r.second.table_id;
    if (pos[a] && pos[b] && (pos[a][0] > pos[b][0] || (isCross && pos[a][0] === pos[b][0] && pos[a][1] > pos[b][1]))) [a, b] = [b, a];
    return { idx, isCross, r, a, b };
  });
  // several lines ending in the same table (e.g. dimensions -> second fact): label at the line's start
  const incoming = {};
  for (const e of edges) incoming[e.b] = (incoming[e.b] || 0) + 1;

  for (const { idx, isCross, r, a, b } of edges) {
    if (!(a in pos) || !(b in pos)) continue;
    const converge = incoming[b] > 1;
    const [ax, ay] = boxXY(a), [bx, by] = boxXY(b);
    const y1 = ay + BOX_H / 2, y2 = by + BOX_H / 2;
    let d, x1, x2;
    if (bx > ax) {
      x1 = ax + bw(a);
      x2 = bx;
      // with labels the bend sits away from the label's end, leaving the long segment for the label
      const xm = !edgeLabels ? x2 - colGap / 2 : converge ? x2 - COL_GAP / 2 : x1 + COL_GAP / 2;
      d = elbow(x1, y1, x2, y2, xm);
    } else { // same column: loop out to the right
      x1 = ax + bw(a);
      const bulge = x1 + colGap / 2;
      d = `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x1},${y2}`;
      x2 = x1;
    }
    const color = factColor[r.first.table_id] || factColor[r.second.table_id];
    const style = color ? ` style="stroke:${color}"` : "";
    S.push(`<g class="rel${mk(marks?.rels?.[idx])}" data-rel="${idx}" data-a="${esc(r.first.table_id)}" data-b="${esc(r.second.table_id)}"><title>${esc(relTip(r))}</title>` +
      `<path class="edge${isCross ? " cross" : ""}" d="${d}"${style}/><path class="hit" d="${d}"/>`);
    if (edgeLabels && bx > ax) {
      S.push(converge
        ? `<text class="elbl" x="${x1 + 6}" y="${y1 - 5}">${esc(edgeLabel(r))}</text>`
        : `<text class="elbl" x="${x2 - 6}" y="${y2 - 5}" text-anchor="end">${esc(edgeLabel(r))}</text>`);
    }
    S.push("</g>");
  }

  for (const [tid, t] of Object.entries(tables)) {
    const [bx, by] = boxXY(tid);
    const tip = [names[tid]];
    if (t.role) tip.push(`role: ${t.role}`);
    if (simpleTable(t.physical)) tip.push(`table: ${unqualify(t.physical.table)}`);
    else if (t.physical) tip.push(`physical tables: ${[...physicalTableNames(t.physical)].sort().join(", ")}`);
    const cn = leafConnections(t.physical).map((c) => conns[c] ?? c);
    if (cn.length) tip.push(`connection: ${cn.join(", ")}`);
    if (t.columns.length) tip.push(`columns: ${t.columns.length}`);
    S.push(`<g class="tbl${mk(marks?.tables?.[tid])}" data-table="${esc(tid)}"><title>${esc(tip.join("\n"))}</title>` +
      `<rect class="box" x="${bx}" y="${by}" width="${bw(tid)}" height="${BOX_H}" rx="1"/>` +
      `<text class="lbl" x="${bx + 10}" y="${by + BOX_H / 2 + 4}">${esc(names[tid])}</text>` +
      (factColor[tid] ? `<rect x="${bx}" y="${by}" width="4" height="${BOX_H}" fill="${factColor[tid]}"/>` : "") +
      "</g>");
  }
  S.push("</svg>");
  return S.join("\n");
}

/** Rasterise an SVG string to a PNG Blob (browser only). */
export function svgToPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const c = canvas.getContext("2d");
      c.scale(scale, scale);
      c.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("PNG export failed")); };
    img.src = url;
  });
}
