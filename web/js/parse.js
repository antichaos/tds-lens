// TDS Lens - parser for Tableau data source XML (.tds / .twb).
// Port of tds_structure.py; runs in the browser (DOMParser) and in Node (@xmldom/xmldom).
//
// Tableau writes feature-flagged tags/attributes such as
//   <_.fcp.ObjectModelEncapsulateLegacy.true...object-graph>
//   <_.fcp.ObjectModelEncapsulateLegacy.false...relation ...>
// The ".true..." variant is the current definition, the ".false..." variant is a
// fallback for older Tableau versions, so we strip the prefix and skip ".false".

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

export const lname = (name) => name.split("...").pop();

export const disabled = (name) => name.includes("...") && name.split("...")[0].endsWith(".false");

export function attrs(el) {
  const out = {};
  if (!el) return out;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (!disabled(a.name)) out[lname(a.name)] = a.value;
  }
  return out;
}

const tagOf = (el) => el.tagName || el.nodeName;

export function kids(el, name = null) {
  if (!el) return [];
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1 || disabled(tagOf(n))) continue;
    if (name === null || lname(tagOf(n)) === name) out.push(n);
  }
  return out;
}

export const kid = (el, name) => kids(el, name)[0] || null;

export function descendants(el, name) {
  const out = [];
  const walk = (node) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 1 || disabled(tagOf(n))) continue;
      if (lname(tagOf(n)) === name) out.push(n);
      walk(n);
    }
  };
  if (el) walk(el);
  return out;
}

function anyTagContains(el, needle) {
  if (tagOf(el).includes(needle)) return true;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && anyTagContains(n, needle)) return true;
  }
  return false;
}

const get = (el, name, dflt = "") => (el && el.hasAttribute(name) ? el.getAttribute(name) : dflt);
const text = (el) => (el ? (el.textContent || "").trim() : "");

export const stripBrackets = (s) => (s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s);

const BINARY_OPS = new Set(["=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/"]);

/** Render a Tableau <expression> tree (join clauses, relationship predicates). */
export function exprToStr(el) {
  if (!el) return "";
  const op = get(el, "op");
  const children = kids(el).filter((c) => lname(tagOf(c)) === "expression");
  if (!children.length) return op;
  const parts = children.map(exprToStr);
  if (BINARY_OPS.has(op) && parts.length === 2) return `${parts[0]} ${op} ${parts[1]}`;
  if (op.toUpperCase() === "AND" || op.toUpperCase() === "OR") {
    return parts.map((p) => (p.includes(" AND ") || p.includes(" OR ") ? `(${p})` : p)).join(` ${op.toUpperCase()} `);
  }
  return `${op}(${parts.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const CONN_KNOWN = new Set([
  "class", "server", "port", "dbname", "schema", "username", "authentication",
  "one-time-sql", "query-band-spec", "caption", "name",
]);

function parseConnection(name, caption, c) {
  const a = attrs(c);
  const conn = {
    name,
    caption: caption || a.caption || "",
    cls: a.class || "",
    server: a.server || "",
    port: a.port || "",
    dbname: a.dbname || "",
    schema: a.schema || "",
    username: a.username || "",
    authentication: a.authentication || "",
    initial_sql: a["one-time-sql"] || "",
    query_band: a["query-band-spec"] || "",
    customizations: {},
    other: {},
  };
  for (const cust of descendants(c, "customization")) conn.customizations[get(cust, "name")] = get(cust, "value");
  for (const [k, v] of Object.entries(a)) {
    if (!CONN_KNOWN.has(k) && v !== "" && !k.toLowerCase().includes("password")) conn.other[k] = v;
  }
  return conn;
}

function parseRelation(rel) {
  const a = attrs(rel);
  const typ = a.type || "";
  const node = {
    kind: typ || "other", name: a.name || "", table: "", connection: a.connection || "",
    join_type: "", clause: "", sql: "", children: [], other: {},
  };
  if (typ === "table") node.table = a.table || "";
  else if (typ === "text") {
    node.kind = "custom-sql";
    // only direct text, not nested elements
    let t = "";
    for (let n = rel.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 || n.nodeType === 4) t += n.nodeValue;
    node.sql = t.trim();
  } else if (typ === "join") {
    node.join_type = a.join || "inner";
    node.clause = exprToStr(kid(kid(rel, "clause"), "expression"));
  } else if (typ === "union") node.other["union-all"] = a.all || "";
  const known = new Set(["type", "name", "connection", "table", "join", "all"]);
  for (const [k, v] of Object.entries(a)) if (!known.has(k)) node.other[k] = v;
  node.children = kids(rel, "relation").map(parseRelation);
  return node;
}

export function physicalTableNames(node) {
  if (!node) return new Set();
  const out = new Set(node.name ? [node.name] : []);
  for (const c of node.children) for (const n of physicalTableNames(c)) out.add(n);
  return out;
}

export function parseDatasource(ds) {
  const a = attrs(ds);
  const out = {
    name: a.name || "",
    caption: a.caption || a["formatted-name"] || a.name || "",
    version: a.version || "",
    connections: [],
    model: "",
    tables: [],
    relationships: [],
    extract: {},
    filters: [],
    calculated_fields: 0,
    other_settings: {},
    server_info: {},
  };
  const topConn = kid(ds, "connection");
  const connCaptions = {};

  // --- connections ---------------------------------------------------------
  if (topConn) {
    if (get(topConn, "class") === "federated") {
      for (const nc of descendants(topConn, "named-connection")) {
        const inner = kid(nc, "connection");
        if (inner) {
          const c = parseConnection(get(nc, "name"), get(nc, "caption"), inner);
          out.connections.push(c);
          connCaptions[c.name] = c.caption || c.cls;
        }
      }
    } else {
      out.connections.push(parseConnection(get(topConn, "class"), "", topConn));
    }
    if (get(topConn, "class") === "sqlproxy") {
      out.other_settings.note =
        "This is a reference to a PUBLISHED data source (sqlproxy). Open the published " +
        "data source itself to see its tables and relationships.";
    }
  }

  // --- field-name map: [Region (People)] -> [People].[Region] ---------------
  const colMap = {};
  if (topConn) for (const m of descendants(topConn, "map")) colMap[get(m, "key")] = get(m, "value");

  // --- columns from metadata-records ----------------------------------------
  const byObject = {};
  const byParent = {};
  if (topConn) {
    for (const mr of descendants(topConn, "metadata-record")) {
      if (get(mr, "class") !== "column") continue;
      const t = (n) => text(kid(mr, n));
      const col = {
        name: stripBrackets(t("local-name")),
        remote_name: t("remote-name"),
        datatype: t("local-type"),
        remote_type: t("remote-type"),
        parent: stripBrackets(t("parent-name")),
      };
      const obj = stripBrackets(t("object-id"));
      Object.defineProperty(col, "_hasObject", { value: !!obj, enumerable: false });
      if (obj) (byObject[obj] ||= []).push(col);
      (byParent[col.parent] ||= []).push(col);
    }
  }

  // --- logical layer (object graph, 2020.2+) ---------------------------------
  const graph = kid(ds, "object-graph");
  if (graph) {
    const multiFact = anyTagContains(graph, "ObjectModelSharedDimensions.true");
    out.model = multiFact
      ? "multi-fact relationships (shared dimensions, 2024.2+)"
      : "relationships (logical layer, 2020.2+)";
    for (const obj of kids(kid(graph, "objects"), "object")) {
      const oid = get(obj, "id");
      let physical = null;
      const contexts = [];
      for (const props of kids(obj, "properties")) {
        const ctx = get(props, "context");
        contexts.push(ctx || "live");
        const rel = kid(props, "relation");
        if (rel && (physical === null || ctx === "")) physical = parseRelation(rel);
      }
      const columns = [...(byObject[oid] || [])];
      for (const n of physicalTableNames(physical)) {
        for (const c of byParent[n] || []) if (!c._hasObject && !columns.includes(c)) columns.push(c);
      }
      out.tables.push({ id: oid, caption: get(obj, "caption", oid), physical, contexts, columns, role: "" });
    }

    const captions = Object.fromEntries(out.tables.map((t) => [t.id, t.caption]));
    for (const r of kids(kid(graph, "relationships"), "relationship")) {
      const predicate = exprToStr(kid(r, "expression"));
      const resolved = predicate.replace(/\[[^\]]+\]/g, (m) => colMap[m] ?? m);
      const ends = ["first-end-point", "second-end-point"].map((tag) => {
        const ea = attrs(kid(r, tag));
        const oid = ea["object-id"] || "";
        const unique = ea["unique-key"] === "true";
        const dbSet = ea["is-db-set-unique-key"] === "true";
        // "Referential integrity: All records match" is stored as guaranteed-value='true'
        const allMatch = ea["guaranteed-value"] === "true";
        return {
          table_id: oid,
          table: captions[oid] ?? oid,
          cardinality: unique ? "One" : "Many",
          unique_key_source: unique ? (dbSet ? "database" : "user") : "",
          referential_integrity: allMatch ? "All records match" : "Some records match",
          raw: ea,
        };
      });
      out.relationships.push({ first: ends[0], second: ends[1], predicate, predicate_resolved: resolved });
    }

    if (multiFact) {
      const oneSide = new Set();
      for (const r of out.relationships) for (const ep of [r.first, r.second]) if (ep.cardinality === "One") oneSide.add(ep.table_id);
      for (const t of out.tables) t.role = oneSide.has(t.id) ? "dimension" : "fact";
    }
  } else if (topConn) {
    // --- legacy single logical table ---------------------------------------
    const rel = kid(topConn, "relation");
    if (rel) {
      out.model = "single logical table (pre-2020.2 / physical joins only)";
      const physical = parseRelation(rel);
      out.tables.push({
        id: physical.name || "table", caption: physical.name || "table", physical,
        contexts: [], columns: Object.values(byParent).flat(), role: "",
      });
    }
  }

  // --- extract -----------------------------------------------------------------
  const ext = kid(ds, "extract");
  if (ext) {
    const ea = attrs(ext);
    const info = { enabled: ea.enabled || "", attributes: ea };
    const ec = kid(ext, "connection");
    if (ec) {
      info.connection = Object.fromEntries(Object.entries(attrs(ec)).filter(([k]) => !k.toLowerCase().includes("password")));
      const extTables = descendants(ec, "relation").filter((r) => get(r, "type") === "table");
      info.storage = extTables.length > 1 ? "multiple tables" : "single table";
      info.tables = extTables.map((r) => get(r, "table", get(r, "name")));
      const refresh = kid(ec, "refresh") || kid(ext, "refresh");
      if (refresh) {
        info.refresh = attrs(refresh);
        const events = kids(refresh, "refresh-event");
        if (events.length) {
          info.last_refresh_event = attrs(events[events.length - 1]);
          info.refresh_events = events.length;
        }
      }
    }
    const flt = descendants(ext, "filter");
    if (flt.length) info.filters = flt.map((f) => get(f, "column"));
    out.extract = info;
  }

  // --- data source filters (applied to every query) ----------------------------
  for (const f of kids(ds, "filter")) {
    out.filters.push({ column: get(f, "column"), class: get(f, "class"), context: get(f, "filter-group") });
  }

  // --- misc ----------------------------------------------------------------------
  out.calculated_fields = kids(ds, "column").filter((c) => kid(c, "calculation")).length;
  const flag = (k) => ["referential", "integrity", "cull", "unique"].some((s) => k.includes(s));
  for (const [k, v] of Object.entries(a)) if (flag(k)) out.other_settings[k] = v;
  if (topConn) for (const [k, v] of Object.entries(attrs(topConn))) if (flag(k)) out.other_settings[`connection.${k}`] = v;

  Object.defineProperty(out, "connCaptions", { value: connCaptions, enumerable: false });
  return out;
}

/** Parse .tds/.twb XML text into a list of data sources. */
export function parseXml(xmlText, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(xmlText, "text/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("This file is not valid XML.");
  const root = doc.documentElement;
  const tag = lname(tagOf(root));
  if (tag === "datasource") return [parseDatasource(root)];
  if (tag === "workbook") {
    const list = kids(kid(root, "datasources"), "datasource").filter((d) => get(d, "name") !== "Parameters");
    if (!list.length) throw new Error("This workbook contains no data sources.");
    return list.map(parseDatasource);
  }
  throw new Error(`Unexpected root element <${tagOf(root)}>: this is not a Tableau data source or workbook.`);
}

/** Return the XML text of a .tds/.twb, or extract it from a .tdsx/.twbx zip. */
export async function readDefinition(bytes, filename, JSZipImpl = globalThis.JSZip) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  if (!isZip) return new TextDecoder("utf-8").decode(u8);
  const zip = await JSZipImpl.loadAsync(u8);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  for (const ext of [".tds", ".twb"]) {
    let hits = names.filter((n) => n.toLowerCase().endsWith(ext) && !n.replace(/^\/+|\/+$/g, "").includes("/"));
    if (!hits.length) hits = names.filter((n) => n.toLowerCase().endsWith(ext));
    if (hits.length) return zip.file(hits[0]).async("string");
  }
  throw new Error(`No .tds or .twb found inside ${filename}.`);
}

// ---------------------------------------------------------------------------
// Display helpers (shared by report + diagram)
// ---------------------------------------------------------------------------

export const simpleTable = (node) => !!node && node.kind === "table" && !node.children.length;

export function leafConnections(node) {
  if (!node) return [];
  const out = node.connection ? [node.connection] : [];
  for (const c of node.children) for (const x of leafConnections(c)) if (!out.includes(x)) out.push(x);
  return out;
}

/** [Tbl].[Col] = [Tbl2].[Col2]  ->  Col = Col2 */
export const unqualify = (expr) => expr.replace(/\[[^\]]+\]\.\[([^\]]+)\]/g, "$1").replace(/[[\]]/g, "");

/** [Tbl].[Col] = [Tbl2].[Col2]  ->  Tbl.Col = Tbl2.Col2 */
export const readable = (expr) => expr.replace(/\[([^\]]+)\]\.\[([^\]]+)\]/g, "$1.$2").replace(/[[\]]/g, "");

const dbTableName = (table) => stripBrackets(table.split("].[").pop().replace(/\]$/, "").replace(/^\[/, ""));

/** {alias: full database table name} for all physical tables under a node. */
export function tableAliases(node) {
  if (!node) return {};
  const out = {};
  if (node.kind === "table" && node.name) out[node.name] = dbTableName(node.table);
  for (const c of node.children) Object.assign(out, tableAliases(c));
  return out;
}

/** Logical table name, or the full DB table name when Tableau auto-shortened it (30 chars). */
export function displayName(t) {
  const cap = t.caption.trim();
  const full = tableAliases(t.physical)[cap] || "";
  if (cap.length >= 25 && full !== cap && full.startsWith(cap)) return full;
  return cap;
}

/** Join clause with Tableau's shortened aliases expanded to full table names. */
export function joinClause(node) {
  let clause = node.clause;
  for (const [alias, full] of Object.entries(tableAliases(node))) {
    if (full !== alias && full.startsWith(alias)) clause = clause.split(`[${alias}].`).join(`[${full}].`);
  }
  return readable(clause);
}

/** Same shape as tds_structure.py --format json. */
export function toJSON(ds) {
  return JSON.parse(JSON.stringify(ds));
}
