// TDS Lens - compare two data sources (e.g. acceptance vs production, or two versions).
// Tables and relationships are matched by name, not by Tableau's internal ids, and
// physical table names are compared without schema/database prefix, so the same model
// on two environments with different schemas only shows the real differences.
import { displayName, fieldLabel, joinClause, unqualify } from "./parse.js";

function physicalSignature(node) {
  if (!node) return "";
  const L = [];
  const walk = (n, ind) => {
    if (n.kind === "table") L.push(`${ind}table ${unqualify(n.table) || n.name}`);
    else if (n.kind === "custom-sql") L.push(`${ind}custom SQL '${n.name}':\n${n.sql.split("\n").map((l) => `${ind}  ${l}`).join("\n")}`);
    else if (n.kind === "join") L.push(`${ind}${n.join_type.toUpperCase()} JOIN on ${joinClause(n)}`);
    else L.push(`${ind}${n.kind} ${n.name}`);
    n.children.forEach((c) => walk(c, ind + "  "));
  };
  walk(node, "");
  return L.join("\n");
}

const joinOn = (r) => unqualify(r.predicate_resolved);
const ri = (ep) => (ep.referential_integrity.startsWith("All") ? "all" : "some");

/**
 * Returns { changes, marks } where
 *   changes: [{ section, kind: "added"|"removed"|"changed", item, a, b, targetA, targetB }]
 *   marks:   { tables: {idInB: kind}, rels: {indexInB: kind} } for highlighting the B diagram
 */
export function compareDatasources(A, B) {
  const changes = [];
  const marks = { tables: {}, rels: {} };
  const add = (section, kind, item, a = "", b = "", targetA = null, targetB = null) =>
    changes.push({ section, kind, item, a: String(a ?? ""), b: String(b ?? ""), targetA, targetB });
  const diff = (section, item, a, b, targetA, targetB) => {
    if (String(a ?? "") !== String(b ?? "")) add(section, "changed", item, a, b, targetA, targetB);
  };

  // --- data source -------------------------------------------------------------
  diff("Data source", "Name", A.caption.trim(), B.caption.trim());
  diff("Data source", "Model", A.model, B.model);

  // --- connections (paired in order) ---------------------------------------------
  const n = Math.max(A.connections.length, B.connections.length);
  for (let i = 0; i < n; i++) {
    const ca = A.connections[i], cb = B.connections[i];
    const label = (c) => `${c.caption || c.name} (${c.cls})`;
    if (!ca) { add("Connections", "added", label(cb), "", label(cb)); continue; }
    if (!cb) { add("Connections", "removed", label(ca), label(ca), ""); continue; }
    const item = n > 1 ? `Connection ${i + 1}: ` : "";
    diff("Connections", `${item}Type`, ca.cls, cb.cls);
    diff("Connections", `${item}Server`, ca.server + (ca.port ? `:${ca.port}` : ""), cb.server + (cb.port ? `:${cb.port}` : ""));
    diff("Connections", `${item}Database`, ca.dbname, cb.dbname);
    diff("Connections", `${item}Schema`, ca.schema, cb.schema);
    diff("Connections", `${item}Login`, ca.username, cb.username);
    diff("Connections", `${item}Authentication`, ca.authentication, cb.authentication);
    diff("Connections", `${item}Initial SQL`, ca.initial_sql, cb.initial_sql);
    diff("Connections", `${item}Query band`, ca.query_band, cb.query_band);
    const cust = (c) => Object.entries(c.customizations).map(([k, v]) => `${k} = ${v}`).sort().join("\n");
    diff("Connections", `${item}Customizations`, cust(ca), cust(cb));
  }

  // --- tables ----------------------------------------------------------------------
  const tablesA = new Map(A.tables.map((t) => [displayName(t), t]));
  const tablesB = new Map(B.tables.map((t) => [displayName(t), t]));
  for (const [name, t] of tablesA) if (!tablesB.has(name)) add("Tables", "removed", name, "present", "", { table: t.id });
  for (const [name, t] of tablesB) {
    const ta = tablesA.get(name);
    if (!ta) { add("Tables", "added", name, "", "present", null, { table: t.id }); marks.tables[t.id] = "added"; continue; }
    const before = changes.length;
    diff("Tables", `${name}: role`, ta.role, t.role, { table: ta.id }, { table: t.id });
    diff("Tables", `${name}: physical layer`, physicalSignature(ta.physical), physicalSignature(t.physical), { table: ta.id }, { table: t.id });
    // columns
    const colsA = new Map(ta.columns.map((c) => [c.name, c])), colsB = new Map(t.columns.map((c) => [c.name, c]));
    const removed = [...colsA.keys()].filter((k) => !colsB.has(k));
    const added = [...colsB.keys()].filter((k) => !colsA.has(k));
    const retyped = [...colsB.keys()].filter((k) => colsA.has(k) && colsA.get(k).datatype !== colsB.get(k).datatype);
    if (removed.length) add("Columns", "removed", `${name}: ${removed.length} column${removed.length === 1 ? "" : "s"}`, removed.join(", "), "", { table: ta.id }, { table: t.id });
    if (added.length) add("Columns", "added", `${name}: ${added.length} column${added.length === 1 ? "" : "s"}`, "", added.join(", "), { table: ta.id }, { table: t.id });
    for (const k of retyped) add("Columns", "changed", `${name}: ${k} data type`, colsA.get(k).datatype, colsB.get(k).datatype, { table: ta.id }, { table: t.id });
    if (changes.length > before) marks.tables[t.id] = "changed";
  }

  // --- relationships (matched by the pair of table names) ------------------------------
  const relKey = (ds, r) => {
    const names = [displayName(ds.tables.find((t) => t.id === r.first.table_id) || { caption: r.first.table, physical: null }),
      displayName(ds.tables.find((t) => t.id === r.second.table_id) || { caption: r.second.table, physical: null })];
    return { key: [...names].sort().join(" ↔ "), names };
  };
  const relsA = new Map(), relsB = new Map();
  A.relationships.forEach((r, idx) => { const k = relKey(A, r); relsA.set(k.key, { r, idx, names: k.names }); });
  B.relationships.forEach((r, idx) => { const k = relKey(B, r); relsB.set(k.key, { r, idx, names: k.names }); });
  for (const [key, x] of relsA) if (!relsB.has(key)) add("Relationships", "removed", `${x.names[0]} – ${x.names[1]}`, joinOn(x.r), "", { rel: x.idx });
  for (const [key, y] of relsB) {
    const label = `${y.names[0]} – ${y.names[1]}`;
    const x = relsA.get(key);
    if (!x) { add("Relationships", "added", label, "", joinOn(y.r), null, { rel: y.idx }); marks.rels[y.idx] = "added"; continue; }
    // orient A's end points like B's
    const endsA = x.names[0] === y.names[0] ? [x.r.first, x.r.second] : [x.r.second, x.r.first];
    const endsB = [y.r.first, y.r.second];
    const before = changes.length;
    const tA = { rel: x.idx }, tB = { rel: y.idx };
    diff("Relationships", `${label}: joined on`, joinOn(x.r), joinOn(y.r), tA, tB);
    diff("Relationships", `${label}: cardinality`, `${endsA[0].cardinality} : ${endsA[1].cardinality}`, `${endsB[0].cardinality} : ${endsB[1].cardinality}`, tA, tB);
    diff("Relationships", `${label}: records match`, `${ri(endsA[0])} / ${ri(endsA[1])}`, `${ri(endsB[0])} / ${ri(endsB[1])}`, tA, tB);
    if (changes.length > before) marks.rels[y.idx] = "changed";
  }

  // --- extract, filters, calculations ---------------------------------------------------
  const ex = (ds) => ds.extract || {};
  diff("Extract", "Extract", ex(A).enabled === "true" ? "yes" : "no", ex(B).enabled === "true" ? "yes" : "no");
  if (ex(A).enabled === "true" && ex(B).enabled === "true") {
    diff("Extract", "Storage", ex(A).storage, ex(B).storage);
    diff("Extract", "Extract filters", (ex(A).filters || []).map((f) => fieldLabel(A, f)).sort().join(", "),
      (ex(B).filters || []).map((f) => fieldLabel(B, f)).sort().join(", "));
  }
  diff("Filters", "Data source filters", A.filters.map((f) => fieldLabel(A, f.column)).sort().join(", "),
    B.filters.map((f) => fieldLabel(B, f.column)).sort().join(", "));

  const calcs = (ds) => new Map((ds.calculations || []).map((c) => [c.caption, c]));
  const calcA = calcs(A), calcB = calcs(B);
  const formula = (ds, c) => c.formula.replace(/\[(Calculation_\d+)\]/g, (m) => `[${fieldLabel(ds, m)}]`);
  for (const [k, c] of calcA) if (!calcB.has(k)) add("Calculated fields", "removed", k, formula(A, c), "");
  for (const [k, c] of calcB) {
    if (!calcA.has(k)) add("Calculated fields", "added", k, "", formula(B, c));
    else diff("Calculated fields", k, formula(A, calcA.get(k)), formula(B, c));
  }

  return { changes, marks };
}

export const SECTION_ORDER = ["Data source", "Connections", "Tables", "Columns", "Relationships", "Extract", "Filters", "Calculated fields"];
