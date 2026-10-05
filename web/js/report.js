// TDS Lens - HTML report, detail panels and text / Mermaid exports.
import {
  displayName, joinClause, leafConnections, simpleTable, stripBrackets, unqualify,
} from "./parse.js";

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const RAW_KNOWN = new Set(["object-id", "unique-key", "is-db-set-unique-key", "guaranteed-value"]);
const match = (ep) => (ep.referential_integrity.startsWith("All") ? "all" : "some");
const isDefault = (r) =>
  r.first.cardinality === "Many" && r.second.cardinality === "Many" && match(r.first) === "some" && match(r.second) === "some";

/** Split tables and relationships per connection (same rules as the CLI). */
export function groupByConnection(ds) {
  const connNames = ds.connections.map((c) => c.name);
  const names = Object.fromEntries(ds.tables.map((t) => [t.id, displayName(t)]));
  const tableConns = {};
  for (const t of ds.tables) {
    const tc = leafConnections(t.physical).filter((c) => connNames.includes(c));
    tableConns[t.id] = tc.length ? tc : connNames.slice(0, 1);
  }
  const groups = ds.connections.map((c) => {
    const tables = ds.tables.filter((t) => tableConns[t.id].length === 1 && tableConns[t.id][0] === c.name);
    const ids = new Set(tables.map((t) => t.id));
    const rels = ds.relationships
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => ids.has(r.first.table_id) && ids.has(r.second.table_id));
    return { conn: c, tables, rels };
  });
  const multiConnTables = ds.tables.filter((t) => tableConns[t.id].length > 1);
  const single = new Set(ds.tables.filter((t) => tableConns[t.id].length === 1).map((t) => t.id));
  const cross = ds.relationships
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => !(single.has(r.first.table_id) && single.has(r.second.table_id) &&
      tableConns[r.first.table_id][0] === tableConns[r.second.table_id][0]));
  // tables of a data source without connections (rare): show them anyway
  if (!ds.connections.length && ds.tables.length) {
    groups.push({ conn: null, tables: ds.tables, rels: ds.relationships.map((r, idx) => ({ r, idx })) });
  }
  return { groups, multiConnTables, cross: ds.connections.length ? cross : [], names };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function physicalHtml(node, conns, showConn) {
  if (!node) return "";
  const conn = showConn && node.connection ? ` <span class="muted">@ ${esc(conns[node.connection] ?? node.connection)}</span>` : "";
  let head;
  if (node.kind === "table") {
    const tname = stripBrackets(node.table.split(".").pop());
    const alias = node.name && tname !== node.name && !tname.startsWith(node.name);
    head = `<span class="kw">table</span> <code>${esc(unqualify(node.table) || node.name)}</code>` +
      (alias ? ` <span class="muted">(alias ${esc(node.name)})</span>` : "") + conn;
  } else if (node.kind === "custom-sql") {
    head = `<span class="kw">custom SQL</span> <code>${esc(node.name)}</code>${conn}<pre class="sql">${esc(node.sql)}</pre>`;
  } else if (node.kind === "join") {
    head = `<span class="kw join">${esc(node.join_type.toUpperCase())} JOIN</span> on <code>${esc(joinClause(node))}</code>`;
  } else if (node.kind === "union") {
    head = `<span class="kw">UNION</span> <code>${esc(node.name)}</code>`;
  } else {
    head = `<span class="kw">${esc(node.kind)}</span> <code>${esc(node.name)}</code>${conn}`;
  }
  const extra = Object.entries(node.other).filter(([k, v]) => k !== "union-all" && v);
  if (extra.length) head += `<div class="muted small">options: ${esc(extra.map(([k, v]) => `${k}=${v}`).join(", "))}</div>`;
  const kidsHtml = node.children.length ? `<ul class="tree">${node.children.map((c) => `<li>${physicalHtml(c, conns, showConn)}</li>`).join("")}</ul>` : "";
  return head + kidsHtml;
}

function tablesHtml(tables, ds, names, showConn) {
  if (!tables.length) return `<p class="muted">No tables.</p>`;
  const conns = ds.connCaptions || {};
  const groups = [["Fact tables", tables.filter((t) => t.role === "fact")],
    ["Dimension tables", tables.filter((t) => t.role === "dimension")],
    ["", tables.filter((t) => !t.role)]];
  let h = "";
  for (const [title, group] of groups) {
    if (!group.length) continue;
    if (title) h += `<h4 class="group">${title} <span class="count">${group.length}</span></h4>`;
    h += `<ul class="tables">`;
    for (const t of group) {
      h += `<li><button class="tname" data-table="${esc(t.id)}">${esc(names[t.id])}</button>`;
      if (simpleTable(t.physical)) {
        h += ` <code class="src">${esc(unqualify(t.physical.table))}</code>`;
      } else if (t.physical) {
        h += `<div class="phys">${physicalHtml(t.physical, conns, showConn)}</div>`;
      }
      if (t.columns.length) h += ` <span class="muted small">${t.columns.length} column${t.columns.length === 1 ? "" : "s"}</span>`;
      h += `</li>`;
    }
    h += `</ul>`;
  }
  return h;
}

function relsHtml(rels, names) {
  if (!rels.length) return `<p class="muted">No relationships.</p>`;
  const byFrom = new Map();
  for (const item of rels) {
    const from = names[item.r.first.table_id] ?? item.r.first.table;
    if (!byFrom.has(from)) byFrom.set(from, []);
    byFrom.get(from).push(item);
  }
  let h = `<div class="table-wrap"><table class="rels"><thead><tr><th>From</th><th>To</th><th>Joined on</th>` +
    `<th>Cardinality</th><th title="Referential integrity: do all records have a match?">Records match<br><span class="muted">from / to</span></th></tr></thead><tbody>`;
  for (const [from, items] of byFrom) {
    items.sort((a, b) => (names[a.r.second.table_id] ?? "").localeCompare(names[b.r.second.table_id] ?? ""));
    items.forEach(({ r, idx }, i) => {
      const to = names[r.second.table_id] ?? r.second.table;
      const notes = [];
      for (const ep of [r.first, r.second]) {
        if (ep.unique_key_source === "database") notes.push(`${names[ep.table_id] ?? ep.table}: unique key from database`);
        const unknown = Object.entries(ep.raw).filter(([k]) => !RAW_KNOWN.has(k));
        if (unknown.length) notes.push(`${names[ep.table_id] ?? ep.table}: ${unknown.map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      h += `<tr data-rel="${idx}" class="${i === 0 ? "first" : ""}">` +
        `<td>${i === 0 ? `<strong>${esc(from)}</strong>` : ""}</td>` +
        `<td>→ ${esc(to)}</td>` +
        `<td><code>${esc(unqualify(r.predicate_resolved))}</code>${notes.length ? `<div class="muted small">${esc(notes.join("; "))}</div>` : ""}</td>` +
        `<td class="nowrap">${r.first.cardinality} : ${r.second.cardinality}</td>` +
        `<td class="nowrap">${pill(match(r.first))} / ${pill(match(r.second))}` +
        (isDefault(r) ? ` <span class="pill warn" title="Tableau's default performance options. They are probably not set on purpose.">defaults</span>` : "") +
        `</td></tr>`;
    });
  }
  return h + `</tbody></table></div>`;
}

const pill = (m) => `<span class="pill ${m}">${m}</span>`;

function kv(rows) {
  const r = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!r.length) return "";
  return `<dl class="kv">${r.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

/** Everything below the diagram. */
export function renderHtml(ds) {
  const { groups, multiConnTables, cross, names } = groupByConnection(ds);
  let h = "";
  if (ds.other_settings.note) h += `<div class="notice">${esc(ds.other_settings.note)}</div>`;

  groups.forEach(({ conn: c, tables, rels }, i) => {
    h += `<section class="card"><header class="card-head"><span class="eyebrow">Connection ${i + 1} of ${groups.length}</span>` +
      `<h3>${esc(c ? c.caption || c.name : "Tables")}</h3>${c ? `<span class="badge">${esc(c.cls)}</span>` : ""}</header>`;
    if (c) {
      h += kv([
        ["Server", c.server ? esc(c.server + (c.port ? `:${c.port}` : "")) : ""],
        ["Database", c.dbname ? esc(c.dbname) + (c.schema ? ` <span class="muted">schema</span> ${esc(c.schema)}` : "") : ""],
        ["Login", c.username || c.authentication ? esc(c.username || "-") + (c.authentication ? ` <span class="muted">(${esc(c.authentication)})</span>` : "") : ""],
        ["Initial SQL", c.initial_sql ? `<pre class="sql">${esc(c.initial_sql)}</pre>` : ""],
        ["Query band", c.query_band ? `<code>${esc(c.query_band)}</code>` : ""],
        ["Customizations", Object.keys(c.customizations).length
          ? `<details><summary>${Object.keys(c.customizations).length} setting${Object.keys(c.customizations).length === 1 ? "" : "s"}</summary><pre class="sql">${esc(Object.entries(c.customizations).map(([k, v]) => `${k} = ${v}`).join("\n"))}</pre></details>` : ""],
      ]);
    }
    h += `<h4>Tables <span class="count">${tables.length}</span></h4>${tablesHtml(tables, ds, names, false)}`;
    h += `<h4>Relationships <span class="count">${rels.length}</span></h4>${relsHtml(rels, names)}</section>`;
  });

  if (multiConnTables.length) {
    h += `<section class="card"><header class="card-head"><h3>Tables spanning multiple connections</h3></header>` +
      tablesHtml(multiConnTables, ds, names, true) + `</section>`;
  }
  if (cross.length) {
    h += `<section class="card"><header class="card-head"><h3>Cross-connection relationships</h3></header>${relsHtml(cross, names)}</section>`;
  }

  const e = ds.extract;
  if (e && Object.keys(e).length) {
    const ec = e.connection || {};
    const extra = Object.entries(e.attributes || {}).filter(([k, v]) => k !== "enabled" && v);
    h += `<section class="card"><header class="card-head"><h3>Extract</h3></header>` + kv([
      ["Enabled", esc(e.enabled)],
      ["Storage", esc(e.storage || "")],
      ["File", ec.dbname ? `<code>${esc(ec.dbname)}</code>` : ""],
      ["Last update", esc(ec["update-time"] || "")],
      ["Settings", extra.length ? esc(extra.map(([k, v]) => `${k}=${v}`).join(", ")) : ""],
      ["Refresh", e.refresh ? esc(Object.entries(e.refresh).map(([k, v]) => `${k}=${v}`).join(", ")) : ""],
      ["Last refresh", e.last_refresh_event ? esc(Object.entries(e.last_refresh_event).map(([k, v]) => `${k}=${v}`).join(", ")) + ` <span class="muted">(${e.refresh_events} events)</span>` : ""],
      ["Filters", e.filters ? e.filters.map((f) => `<code>${esc(f)}</code>`).join(" ") : ""],
      ["Tables", e.tables && e.tables.length ? `<details><summary>${e.tables.length} tables</summary><ul class="plain">${e.tables.map((t) => `<li><code>${esc(unqualify(t))}</code></li>`).join("")}</ul></details>` : ""],
    ]) + `</section>`;
  }

  if (ds.filters.length) {
    h += `<section class="card"><header class="card-head"><h3>Data source filters</h3></header><ul class="plain">` +
      ds.filters.map((f) => `<li><code>${esc(f.column)}</code> <span class="muted">${esc(f.class)}</span></li>`).join("") + `</ul></section>`;
  }
  const others = Object.entries(ds.other_settings).filter(([k]) => k !== "note");
  if (others.length) {
    h += `<section class="card"><header class="card-head"><h3>Other settings</h3></header>` + kv(others.map(([k, v]) => [k, esc(v)])) + `</section>`;
  }
  return h;
}

/** Side panel for a clicked table. */
export function tableDetail(ds, tid) {
  const t = ds.tables.find((x) => x.id === tid);
  if (!t) return "";
  const conns = ds.connCaptions || {};
  const cn = leafConnections(t.physical).map((c) => conns[c] ?? c);
  const names = Object.fromEntries(ds.tables.map((x) => [x.id, displayName(x)]));
  const rels = ds.relationships.map((r, idx) => ({ r, idx })).filter(({ r }) => r.first.table_id === tid || r.second.table_id === tid);
  let h = `<span class="eyebrow">${t.role ? esc(t.role) + " table" : "Logical table"}</span><h3>${esc(names[tid])}</h3>`;
  if (names[tid] !== t.caption.trim()) h += `<p class="muted small">Name in Tableau: ${esc(t.caption.trim())}</p>`;
  h += kv([["Connection", esc(cn.join(", "))], ["Contexts", t.contexts.length > 1 ? esc(t.contexts.join(", ")) : ""]]);
  h += `<h4>Physical layer</h4><div class="phys">${physicalHtml(t.physical, conns, cn.length > 1) || '<span class="muted">-</span>'}</div>`;
  h += `<h4>Relationships <span class="count">${rels.length}</span></h4>`;
  h += rels.length ? `<ul class="plain">${rels.map(({ r, idx }) => {
    const other = r.first.table_id === tid ? r.second.table_id : r.first.table_id;
    return `<li><button class="link" data-rel="${idx}">${esc(names[other] ?? other)}</button> <code>${esc(unqualify(r.predicate_resolved))}</code></li>`;
  }).join("")}</ul>` : `<p class="muted">None</p>`;
  if (t.columns.length) {
    h += `<h4>Columns <span class="count">${t.columns.length}</span></h4><div class="table-wrap"><table class="cols"><tbody>` +
      t.columns.map((c) => `<tr><td>${esc(c.name)}</td><td class="muted">${esc(c.datatype)}</td>` +
        `<td class="muted small">${c.remote_name && c.remote_name !== c.name ? `← ${esc(c.parent)}.${esc(c.remote_name)}` : ""}</td></tr>`).join("") +
      `</tbody></table></div>`;
  }
  return h;
}

/** Side panel for a clicked relationship. */
export function relDetail(ds, idx) {
  const r = ds.relationships[idx];
  if (!r) return "";
  const names = Object.fromEntries(ds.tables.map((x) => [x.id, displayName(x)]));
  const f = names[r.first.table_id] ?? r.first.table, s = names[r.second.table_id] ?? r.second.table;
  const end = (ep, n) => `<tr><td><button class="link" data-table="${esc(ep.table_id)}">${esc(n)}</button></td>` +
    `<td>${ep.cardinality}${ep.unique_key_source ? ` <span class="muted small">(unique key set by ${ep.unique_key_source})</span>` : ""}</td>` +
    `<td>${pill(match(ep))}</td></tr>`;
  let h = `<span class="eyebrow">Relationship</span><h3>${esc(f)} → ${esc(s)}</h3>`;
  h += `<h4>Joined on</h4><p><code>${esc(unqualify(r.predicate_resolved))}</code></p>`;
  if (r.predicate_resolved !== r.predicate) h += `<p class="muted small">Field names in Tableau: <code>${esc(r.predicate)}</code></p>`;
  h += `<h4>Performance options</h4><div class="table-wrap"><table class="cols"><thead><tr><th>Table</th><th>Cardinality</th><th>Records match</th></tr></thead><tbody>` +
    end(r.first, f) + end(r.second, s) + `</tbody></table></div>`;
  if (isDefault(r)) {
    h += `<p class="hint">These are Tableau's defaults (Many-to-Many, some records match), so they are probably not set on purpose. ` +
      `If you know the real cardinality and that every record has a match, setting them lets Tableau build more efficient queries.</p>`;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Plain-text report (same layout as the CLI) and Mermaid
// ---------------------------------------------------------------------------

function physicalText(node, conns, indent, L, showConn) {
  const conn = showConn && node.connection ? `  @ ${conns[node.connection] ?? node.connection}` : "";
  if (node.kind === "table") {
    const tname = stripBrackets(node.table.split(".").pop());
    const alias = node.name && tname !== node.name && !tname.startsWith(node.name);
    L.push(`${indent}table  ${unqualify(node.table) || node.name}${alias ? `  (alias ${node.name})` : ""}${conn}`);
  } else if (node.kind === "custom-sql") {
    L.push(`${indent}custom SQL  '${node.name}'${conn}`);
    for (const l of node.sql.split("\n")) L.push(`${indent}  │ ${l}`);
  } else if (node.kind === "join") {
    L.push(`${indent}${node.join_type.toUpperCase()} JOIN on ${joinClause(node)}`);
  } else if (node.kind === "union") {
    L.push(`${indent}UNION '${node.name}'`);
  } else {
    L.push(`${indent}${node.kind} ${node.name}${conn}`);
  }
  for (const c of node.children) physicalText(c, conns, indent + "   ", L, showConn);
}

function tablesText(tables, ds, names, L, showConn) {
  const conns = ds.connCaptions || {};
  const w = Math.max(10, ...tables.map((t) => names[t.id].length)) + 2;
  for (const [title, group] of [["Fact tables", tables.filter((t) => t.role === "fact")],
    ["Dimension tables", tables.filter((t) => t.role === "dimension")], ["", tables.filter((t) => !t.role)]]) {
    if (!group.length) continue;
    if (title) L.push(`    ${title} (${group.length})`);
    const ind = title ? "      " : "    ";
    for (const t of group) {
      if (simpleTable(t.physical)) L.push(`${ind}${names[t.id].padEnd(w)}${unqualify(t.physical.table)}`);
      else {
        L.push(`${ind}${names[t.id]}`);
        if (t.physical) physicalText(t.physical, conns, ind + "   ", L, showConn);
      }
    }
  }
}

function relsText(rels, names, L) {
  if (!rels.length) { L.push("    (none)"); return; }
  const rows = rels.map(({ r }) => [names[r.first.table_id] ?? r.first.table, names[r.second.table_id] ?? r.second.table,
    unqualify(r.predicate_resolved), `${r.first.cardinality} : ${r.second.cardinality}`, `${match(r.first)} / ${match(r.second)}`]);
  const wTo = Math.max(8, ...rows.map((r) => r[1].length)) + 2;
  const wOn = Math.max(9, ...rows.map((r) => r[2].length)) + 2;
  L.push(`      ${"  to table".padEnd(wTo + 2)}${"joined on".padEnd(wOn)}${"cardinality".padEnd(13)}records match (from / to)`);
  const byFrom = new Map();
  for (const r of rows) { if (!byFrom.has(r[0])) byFrom.set(r[0], []); byFrom.get(r[0]).push(r); }
  for (const [from, group] of byFrom) {
    L.push(`    ${from}`);
    for (const [, to, on, card, ri] of group.sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()))) {
      L.push(`      → ${to.padEnd(wTo)}${on.padEnd(wOn)}${card.padEnd(13)}${ri}`);
    }
  }
}

export function renderText(ds) {
  const { groups, multiConnTables, cross, names } = groupByConnection(ds);
  const H = "═".repeat(100), R = "─".repeat(100);
  const L = [H, `DATA SOURCE   ${ds.caption}`, H,
    `  Model        ${ds.model || "unknown"}`,
    `  Summary      ${ds.connections.length} connection(s), ${ds.tables.length} table(s), ${ds.relationships.length} relationship(s), ${ds.calculated_fields} calculated field(s)`];
  if (ds.other_settings.note) L.push(`  NOTE         ${ds.other_settings.note}`);
  const section = (t) => L.push("", R, t, R);
  groups.forEach(({ conn: c, tables, rels }, i) => {
    section(`CONNECTION ${i + 1} of ${groups.length}   ${c ? c.caption || c.name : ""}   (${c ? c.cls : ""})`);
    if (c) {
      if (c.server) L.push(`  Server       ${c.server}${c.port ? `:${c.port}` : ""}`);
      if (c.dbname) L.push(`  Database     ${c.dbname}${c.schema ? `   schema: ${c.schema}` : ""}`);
      if (c.username || c.authentication) L.push(`  Login        ${c.username || "-"}${c.authentication ? `   (${c.authentication})` : ""}`);
      if (c.initial_sql) c.initial_sql.split("\n").forEach((l, j) => L.push(`${j ? "               " : "  Initial SQL  "}${l}`));
      if (c.query_band) L.push(`  Query band   ${c.query_band}`);
    }
    L.push("", `  TABLES (${tables.length})`);
    tablesText(tables, ds, names, L, false);
    L.push("", `  RELATIONSHIPS (${rels.length})`);
    relsText(rels, names, L);
  });
  if (multiConnTables.length) { section(`TABLES SPANNING MULTIPLE CONNECTIONS (${multiConnTables.length})`); tablesText(multiConnTables, ds, names, L, true); }
  if (cross.length) { section(`CROSS-CONNECTION RELATIONSHIPS (${cross.length})`); relsText(cross, names, L); }
  const e = ds.extract;
  if (e && Object.keys(e).length) {
    section("EXTRACT");
    L.push(`  Enabled      ${e.enabled}`, `  Storage      ${e.storage || "?"}`);
    if (e.connection) L.push(`  File         ${e.connection.dbname || ""}`, `  Last update  ${e.connection["update-time"] || "-"}`);
    if (e.filters) L.push(`  Filters      ${e.filters.join(", ")}`);
    if (e.tables && e.tables.length) { L.push(`  Tables (${e.tables.length}):`); e.tables.forEach((t) => L.push(`    - ${unqualify(t)}`)); }
  }
  if (ds.filters.length) { section(`DATA SOURCE FILTERS (${ds.filters.length})`); ds.filters.forEach((f) => L.push(`  - ${f.column}  (${f.class})`)); }
  L.push("");
  return L.join("\n");
}

const mermaidId = (s) => s.replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "T";

export function renderMermaid(ds) {
  const L = ["erDiagram", `    %% ${ds.caption}`];
  const ids = {};
  for (const t of ds.tables) {
    ids[t.id] = mermaidId(t.caption);
    L.push(`    ${ids[t.id]}["${displayName(t).replace(/"/g, "'")}"]`);
  }
  for (const r of ds.relationships) {
    const left = r.first.cardinality === "One" ? "||" : "}o";
    const right = r.second.cardinality === "One" ? "||" : "o{";
    L.push(`    ${ids[r.first.table_id] ?? mermaidId(r.first.table)} ${left}--${right} ${ids[r.second.table_id] ?? mermaidId(r.second.table)} : "${unqualify(r.predicate_resolved).replace(/"/g, "'")}"`);
  }
  return L.join("\n");
}
