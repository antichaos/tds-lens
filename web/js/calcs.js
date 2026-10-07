// Calc Lens - finds expensive calculations in a Tableau workbook (.twb/.twbx) or data source.
// Pure analysis on the XML (DOMParser in the browser, @xmldom/xmldom in Node); no page code here.
//
// Pipeline: parseCalcModel (XML -> data sources, calculations, sheets, dashboards)
//        -> analyzeCalcs (formula rules + dependency graph + usage -> findings and a priority per calc)

import { descendants, kid, kids, lname, stripBrackets } from "./parse.js";

const get = (el, name, dflt = "") => (el && el.hasAttribute(name) ? el.getAttribute(name) : dflt);
const tagOf = (el) => el.tagName || el.nodeName;
const text = (el) => (el ? (el.textContent || "").trim() : "");
/** "[Order Date]" -> "Order Date"; Tableau escapes "]" inside names as "]]". */
const bare = (s) => stripBrackets(s || "").replace(/\]\]/g, "]");

// ---------------------------------------------------------------------------
// Rules: one place for the wording, used by the findings, the page and the exports
// ---------------------------------------------------------------------------

export const RULES = [
  { code: "string-to-date", group: "String logic", severity: "high", title: "Text converted to a date",
    why: "Parsing dates from text (DATEPARSE, or DATE/DATETIME on a string) runs for every row and stops the database from using indexes, partitions or date pruning. Store a real date column in the source, or convert it once in the ETL or extract." },
  { code: "long-branch", group: "String logic", severity: "medium / high", title: "Long IF or CASE chain (10+ branches)",
    why: "Every row walks through the branches until one matches, and long chains are hard to push down efficiently. A group, a set, or a small mapping table joined to the data is usually faster and easier to maintain." },
  { code: "string-compare", group: "String logic", severity: "low", title: "Many string comparisons (5+)",
    why: "Comparing strings is much slower than comparing numbers or booleans, and it happens on every row. Compare on an ID or code, or use a group or mapping table." },
  { code: "regex", group: "String logic", severity: "medium", title: "Regular expression",
    why: "REGEXP_ functions are evaluated row by row, cannot use indexes, and are among the slowest string operations. Not every database supports them." },
  { code: "string-functions", group: "String logic", severity: "low / medium", title: "String functions",
    why: "String operations (CONTAINS, FIND, LEFT, LOWER, SPLIT…) run on every row and are much slower than number or date logic. Prepare the value in the source or the extract when it is used in many places." },
  { code: "lod", group: "LOD & table calcs", severity: "medium", title: "FIXED / INCLUDE / EXCLUDE expression",
    why: "Each LOD expression becomes a separate subquery at its own level of detail that is joined back to the view. FIXED ignores dimension filters unless they are context filters, which often leads to extra context filters (temporary tables)." },
  { code: "lod-table", group: "LOD & table calcs", severity: "low", title: "Table-scoped LOD ({ SUM(…) })",
    why: "A table-scoped LOD adds one extra subquery over the whole table." },
  { code: "lod-nested", group: "LOD & table calcs", severity: "high", title: "Nested LOD expressions",
    why: "An LOD inside an LOD gives subqueries inside subqueries; the inner level has to be computed first for every query." },
  { code: "table-calc", group: "LOD & table calcs", severity: "medium", title: "Table calculation",
    why: "Table calculations run in Tableau on the query result, not in the database. Their cost grows with the number of marks; WINDOW_ functions over large partitions grow fastest." },
  { code: "table-calc-nested", group: "LOD & table calcs", severity: "high", title: "Table calculation over a table calculation",
    why: "Every level is another pass over all marks, and the addressing of each level has to match. Slow on large views and easy to get wrong." },
  { code: "table-calc-filter", group: "Usage", severity: "medium", title: "Table calculation used as a filter",
    why: "A table calculation filter only hides marks after everything is queried and computed: the database still returns all rows. Filter on a regular field, or use a FIXED LOD or a parameter in the query where possible." },
  { code: "deep-chain", group: "Dependencies", severity: "low / medium", title: "Calculation chain 4+ levels deep",
    why: "Tableau copies every referenced calculation into one expression. Deep chains produce long queries that are hard for the database to optimise, and they hide where the expensive parts are." },
  { code: "inherits", group: "Dependencies", severity: "low", title: "Builds on expensive calculations",
    why: "Referencing a calculation copies its formula into this one, so its cost is paid here too." },
  { code: "unused", group: "Usage", severity: "low", title: "Not used in any sheet",
    why: "Unused calculations cost nothing at query time, but they clutter the data pane and make the workbook harder to maintain. Remove them if nobody needs them." },
  { code: "blending", group: "Other", severity: "medium", title: "Data blending",
    why: "A blend runs a separate query on the secondary data source and joins the results in Tableau. With many linking values this is slow; a relationship or join is usually faster." },
  { code: "aggregation", group: "Other", severity: "low", title: "Expensive aggregation (COUNTD, MEDIAN, PERCENTILE)",
    why: "Distinct counts, medians and percentiles need all values per group to be sorted or hashed; on large live tables they are among the slowest aggregations." },
  { code: "volatile", group: "Other", severity: "low", title: "NOW, TODAY or RANDOM",
    why: "The result changes over time, so Tableau cannot fully reuse cached results, and an extract cannot store the calculated value." },
  { code: "user-function", group: "Other", severity: "low", title: "User function (USERNAME, ISMEMBEROF…)",
    why: "User functions make query results user-specific, so cached results are not shared between users. Expected for row-level security; avoid them elsewhere." },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.code, r]));
export const GROUPS = ["String logic", "LOD & table calcs", "Dependencies", "Usage", "Other"];

export const SEVERITIES = ["none", "low", "medium", "high"];
const rank = (s) => SEVERITIES.indexOf(s);
const maxSev = (list) => list.reduce((m, s) => (rank(s) > rank(m) ? s : m), "none");

// ---------------------------------------------------------------------------
// Formula tokenizer and analysis
// ---------------------------------------------------------------------------

/** Split a Tableau formula into tokens; comments are dropped. Fields keep their data source qualifier. */
export function tokenize(src) {
  const toks = [];
  const n = src.length;
  const NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const ID = /[A-Za-z_][A-Za-z0-9_]*/y;
  // read "[...]" starting at k (Tableau escapes "]" as "]]"); returns [name, index after "]"]
  const bracket = (k) => {
    let v = "";
    k++;
    while (k < n) {
      if (src[k] === "]") {
        if (src[k + 1] === "]") { v += "]"; k += 2; continue; }
        break;
      }
      v += src[k++];
    }
    return [v, k + 1];
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, v = "";
      while (j < n) {
        if (src[j] === c) {
          if (src[j + 1] === c) { v += c; j += 2; continue; }
          break;
        }
        v += src[j++];
      }
      toks.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const [name, j] = bracket(i);
      if (src[j] === "." && src[j + 1] === "[") {
        const [field, k] = bracket(j + 1);
        toks.push({ t: "field", ds: name, v: field });
        i = k;
      } else {
        toks.push({ t: "field", ds: "", v: name });
        i = j;
      }
      continue;
    }
    if (c === "#") {
      const j = src.indexOf("#", i + 1);
      toks.push({ t: "date", v: src.slice(i + 1, j < 0 ? n : j) });
      i = j < 0 ? n : j + 1;
      continue;
    }
    NUM.lastIndex = i;
    if (/[0-9.]/.test(c) && NUM.test(src)) {
      toks.push({ t: "num", v: src.slice(i, NUM.lastIndex) });
      i = NUM.lastIndex;
      continue;
    }
    ID.lastIndex = i;
    if (ID.test(src)) {
      const v = src.slice(i, ID.lastIndex);
      toks.push({ t: "id", v, u: v.toUpperCase() });
      i = ID.lastIndex;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "==", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    toks.push({ t: "op", v: c });
    i++;
  }
  return toks;
}

const KEYWORDS = new Set(["IF", "THEN", "ELSEIF", "ELSE", "END", "CASE", "WHEN", "AND", "OR", "NOT", "IN", "FIXED", "INCLUDE", "EXCLUDE", "TRUE", "FALSE", "NULL"]);
export const TABLE_CALC_FN = /^(WINDOW_\w+|RUNNING_\w+|LOOKUP|PREVIOUS_VALUE|INDEX|FIRST|LAST|SIZE|RANK(_DENSE|_MODIFIED|_PERCENTILE|_UNIQUE)?|TOTAL|SCRIPT_\w+|MODEL_\w+)$/;
const REGEX_FN = /^REGEXP_\w+$/;
const STRING_FN = new Set(["CONTAINS", "FIND", "FINDNTH", "STARTSWITH", "ENDSWITH", "SPLIT", "REPLACE", "MID", "LEFT", "RIGHT",
  "UPPER", "LOWER", "TRIM", "LTRIM", "RTRIM", "LEN", "PROPER", "SPACE", "ASCII", "CHAR"]);
const STRINGISH_FN = new Set([...STRING_FN, "STR"]);
const AGG_FN = new Set(["COUNTD", "MEDIAN", "PERCENTILE"]);
const VOLATILE_FN = new Set(["NOW", "TODAY", "RANDOM"]);
const USER_FN = new Set(["USERNAME", "FULLNAME", "USERDOMAIN", "ISMEMBEROF", "ISUSERNAME", "ISFULLNAME", "USERATTRIBUTE", "USERATTRIBUTEINCLUDES"]);
const COMPARE = new Set(["=", "==", "<>", "!="]);

/**
 * Structural facts about one formula: function calls, field references (also those inside an LOD or
 * a table calculation), LOD expressions, IF/CASE branch counts, string comparisons and date casts.
 */
export function analyzeFormula(formula) {
  const toks = tokenize(formula || "");
  const out = {
    functions: {}, refs: [], lodRefs: [], tcRefs: [],
    lods: [], lodDepth: 0, tcDepth: 0, tcNested: [],
    branches: 0, stringCompares: 0, dateCasts: [],
  };
  const blocks = []; // open IF / CASE blocks
  const lods = []; // open { ... }
  const frames = []; // open parentheses: { fn, tc, fields, strish }
  const seen = new Set();
  const addRef = (list, ref) => { if (!list.some((r) => r.ds === ref.ds && r.v === ref.v)) list.push(ref); };

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], prev = toks[k - 1], next = toks[k + 1];
    if (t.t === "field") {
      const ref = { ds: t.ds, v: t.v };
      if (!seen.has(`${t.ds}|${t.v}`)) { seen.add(`${t.ds}|${t.v}`); out.refs.push(ref); }
      if (lods.length) addRef(out.lodRefs, ref);
      if (frames.some((f) => f.tc)) addRef(out.tcRefs, ref);
      if (frames.length) frames[frames.length - 1].fields.push(ref);
      continue;
    }
    // "text-ness" belongs to the innermost parentheses; it only bubbles up through string functions
    if (t.t === "str" && frames.length) frames[frames.length - 1].strish = true;
    if (t.t === "id") {
      if (next && next.t === "op" && next.v === "(" && !KEYWORDS.has(t.u)) {
        out.functions[t.u] = (out.functions[t.u] || 0) + 1;
        if (STRINGISH_FN.has(t.u) && frames.length) frames[frames.length - 1].strish = true;
        continue; // the "(" opens the frame
      }
      if (t.u === "IF") blocks.push({ kind: "if", n: 1 });
      else if (t.u === "CASE") blocks.push({ kind: "case", n: 0 });
      else if (t.u === "ELSEIF") { const b = [...blocks].reverse().find((x) => x.kind === "if"); if (b) b.n++; }
      else if (t.u === "WHEN") {
        const b = [...blocks].reverse().find((x) => x.kind === "case");
        if (b) b.n++;
        if (next && next.t === "str") out.stringCompares++;
      } else if (t.u === "END") {
        const b = blocks.pop();
        if (b) out.branches = Math.max(out.branches, b.n);
      } else if (t.u === "IN" && next && next.v === "(") {
        for (let j = k + 2; j < toks.length && toks[j].v !== ")"; j++) if (toks[j].t === "str") out.stringCompares++;
      }
      continue;
    }
    if (t.t !== "op") continue;
    if (t.v === "(") {
      const fn = prev && prev.t === "id" && !KEYWORDS.has(prev.u) ? prev.u : "";
      const tc = TABLE_CALC_FN.test(fn);
      if (tc) {
        const outer = frames.filter((f) => f.tc).map((f) => f.fn);
        if (outer.length) out.tcNested.push(`${outer[outer.length - 1]}(${fn}(…))`);
        out.tcDepth = Math.max(out.tcDepth, outer.length + 1);
      }
      frames.push({ fn, tc, fields: [], strish: false });
    } else if (t.v === ")") {
      const f = frames.pop();
      if (f && (f.fn === "DATE" || f.fn === "DATETIME")) out.dateCasts.push({ fn: f.fn, fields: f.fields, strish: f.strish });
      const parent = frames[frames.length - 1];
      if (f && parent && (f.fn === "" || STRINGISH_FN.has(f.fn))) {
        parent.strish ||= f.strish;
        if (f.fn === "") parent.fields.push(...f.fields);
      }
    } else if (t.v === "{") {
      let type = "TABLE", dims = 0;
      if (next && next.t === "id" && ["FIXED", "INCLUDE", "EXCLUDE"].includes(next.u)) {
        type = next.u;
        // dimensions: comma-separated expressions up to ":" at this nesting level
        let depth = 0, any = false;
        for (let j = k + 2; j < toks.length; j++) {
          const x = toks[j];
          if (x.v === "(" || x.v === "{") depth++;
          else if (x.v === ")" || x.v === "}") depth--;
          if (depth < 0) break;
          if (depth === 0 && x.v === ":") break;
          if (depth === 0 && x.v === ",") dims++;
          any = true;
        }
        dims = any ? dims + 1 : 0;
      }
      lods.push(type);
      out.lods.push({ type, dims, depth: lods.length });
      out.lodDepth = Math.max(out.lodDepth, lods.length);
    } else if (t.v === "}") {
      lods.pop();
    } else if (COMPARE.has(t.v) && ((prev && prev.t === "str") || (next && next.t === "str"))) {
      out.stringCompares++;
    }
  }
  for (const b of blocks) out.branches = Math.max(out.branches, b.n); // unterminated formula
  return out;
}

// ---------------------------------------------------------------------------
// XML -> model
// ---------------------------------------------------------------------------

/** "[none:Calculation_123:nk]" -> "Calculation_123"; "[Sales]" -> "Sales". */
export function instanceField(name) {
  const parts = bare(name).split(":");
  return parts.length >= 3 ? parts[parts.length - 2] : bare(name);
}

/** "[federated.x].[none:Region:nk]" -> { ds: "federated.x", inst: "none:Region:nk" } */
function splitQualified(s) {
  const m = /^\[((?:[^\]]|\]\])+)\]\.\[((?:[^\]]|\]\])+)\]$/.exec((s || "").trim());
  return m ? { ds: m[1].replace(/\]\]/g, "]"), inst: m[2].replace(/\]\]/g, "]") } : { ds: "", inst: bare(s) };
}

function calcOf(col) {
  const calc = kid(col, "calculation");
  if (!calc || !get(calc, "formula")) return null;
  const cls = get(calc, "class", "tableau");
  if (cls !== "tableau") return null; // bins, groups
  return {
    name: bare(get(col, "name")),
    caption: get(col, "caption"),
    formula: get(calc, "formula"),
    datatype: get(col, "datatype"),
    role: get(col, "role"),
    hidden: get(col, "hidden") === "true",
    tableCalcSettings: !!kid(calc, "table-calc"),
  };
}

function parseDatasourceCalcs(el) {
  const name = get(el, "name");
  const conn = kid(el, "connection");
  const fields = {}; // bare name -> { caption, datatype }
  for (const mr of descendants(conn, "metadata-record")) {
    if (get(mr, "class") !== "column") continue;
    fields[bare(text(kid(mr, "local-name")))] = { caption: "", datatype: text(kid(mr, "local-type")) };
  }
  const calcs = [];
  for (const col of kids(el, "column")) {
    const n = bare(get(col, "name"));
    if (!n) continue;
    const prev = fields[n] || {};
    fields[n] = { caption: get(col, "caption") || prev.caption || "", datatype: get(col, "datatype") || prev.datatype || "" };
    const c = name !== "Parameters" && calcOf(col);
    if (c) calcs.push(c);
  }
  const filters = kids(el, "filter").map((f) => bare(get(f, "column")));
  const extractFilters = descendants(kid(el, "extract"), "filter").map((f) => bare(get(f, "column")));
  return {
    name,
    caption: get(el, "caption") || name,
    published: !!conn && get(conn, "class") === "sqlproxy",
    isParameters: name === "Parameters",
    fields, calcs, filters: [...filters, ...extractFilters],
  };
}

/** Parse workbook or data source XML into the model analyzeCalcs works on. */
export function parseCalcModel(xmlText, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(xmlText, "text/xml");
  if (doc.getElementsByTagName("parsererror")[0]) throw new Error("This file is not valid XML.");
  const root = doc.documentElement;
  const tag = lname(tagOf(root));
  if (tag !== "workbook" && tag !== "datasource") {
    throw new Error(`Unexpected root element <${tagOf(root)}>: this is not a Tableau workbook or data source.`);
  }
  const model = { kind: tag, version: get(root, "version"), datasources: [], worksheets: [], dashboards: [] };
  const dsEls = tag === "datasource" ? [root] : kids(kid(root, "datasources"), "datasource");
  model.datasources = dsEls.map(parseDatasourceCalcs);
  if (tag === "datasource") return model;

  const dsByName = Object.fromEntries(model.datasources.map((d) => [d.name, d]));
  for (const ws of kids(kid(root, "worksheets"), "worksheet")) {
    const sheet = { name: get(ws, "name"), uses: [] };
    const view = kid(kid(ws, "table"), "view");
    const instances = {}; // "ds|inst" -> field
    for (const dep of kids(view, "datasource-dependencies")) {
      const dsn = get(dep, "datasource");
      const owner = dsByName[dsn];
      for (const col of kids(dep, "column")) {
        // ad-hoc calculations (typed on a shelf) only exist in the sheet
        const c = calcOf(col);
        if (c && owner && !owner.calcs.some((x) => x.name === c.name)) {
          owner.calcs.push({ ...c, adhoc: sheet.name });
          if (!owner.fields[c.name]) owner.fields[c.name] = { caption: c.caption, datatype: c.datatype };
        }
      }
      for (const ci of kids(dep, "column-instance")) {
        const field = bare(get(ci, "column"));
        instances[`${dsn}|${bare(get(ci, "name"))}`] = field;
        sheet.uses.push({ ds: dsn, field, filter: false });
      }
    }
    for (const f of kids(view, "filter")) {
      const { ds, inst } = splitQualified(get(f, "column"));
      const field = instances[`${ds}|${inst}`] || instanceField(inst);
      sheet.uses.push({ ds, field, filter: true });
    }
    model.worksheets.push(sheet);
  }
  const sheetNames = new Set(model.worksheets.map((w) => w.name));
  for (const d of kids(kid(root, "dashboards"), "dashboard")) {
    const sheets = [];
    for (const z of descendants(d, "zone")) {
      const n = get(z, "name");
      if (sheetNames.has(n) && !sheets.includes(n)) sheets.push(n);
    }
    model.dashboards.push({ name: get(d, "name"), story: get(d, "type") === "storyboard", sheets });
  }
  return model;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Formula with internal names replaced by captions: [Calculation_123] -> [Profit Ratio]. */
export function displayFormula(formula, ds, paramFields = {}) {
  const re = /('(?:[^']|'')*'|"(?:[^"]|"")*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\[((?:[^\]]|\]\])+)\](?:\.\[((?:[^\]]|\]\])+)\])?/g;
  return formula.replace(re, (m, skip, a, b) => {
    if (skip) return m;
    if (b !== undefined) {
      if (a === "Parameters" && paramFields[bare(`[${b}]`)]?.caption) return `[Parameters].[${paramFields[bare(`[${b}]`)].caption}]`;
      return m;
    }
    const cap = ds.fields[bare(`[${a}]`)]?.caption;
    return cap ? `[${cap.replace(/\]/g, "]]")}]` : m;
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fnList = (fns) => Object.entries(fns).map(([f, n]) => (n > 1 ? `${f} ×${n}` : f)).join(", ");

/**
 * Findings, dependencies, usage and priority for every calculation in the model.
 * Returns { calcs, summary } with calcs sorted most urgent first.
 */
export function analyzeCalcs(model) {
  const hasSheets = model.worksheets.length > 0;
  const params = model.datasources.find((d) => d.isParameters);
  const paramFields = params ? params.fields : {};
  const dsByName = Object.fromEntries(model.datasources.map((d) => [d.name, d]));
  const calcs = [];
  const byKey = new Map();
  for (const ds of model.datasources) {
    for (const c of ds.calcs) {
      const x = {
        key: `${ds.name}::${c.name}`, ds: ds.name, dsCaption: ds.caption, published: ds.published,
        name: c.name, caption: c.caption || c.name, formula: c.formula,
        displayFormula: displayFormula(c.formula, ds, paramFields),
        datatype: c.datatype, role: c.role, hidden: c.hidden, adhoc: c.adhoc || "",
        a: analyzeFormula(c.formula),
      };
      calcs.push(x);
      byKey.set(x.key, x);
    }
  }
  const keyOf = (c, ref) => (!ref.ds || ref.ds === c.ds ? `${c.ds}::${ref.v}` : null);
  const calcRefs = (c, refs) => [...new Set(refs.map((r) => keyOf(c, r)).filter((k) => k && byKey.has(k) && k !== c.key))];
  for (const c of calcs) {
    c.deps = calcRefs(c, c.a.refs);
    c.lodDeps = calcRefs(c, c.a.lodRefs);
    c.tcDeps = calcRefs(c, c.a.tcRefs);
    c.dependents = [];
  }
  for (const c of calcs) for (const k of c.deps) byKey.get(k).dependents.push(c.key);

  /** All calcs reachable through deps (not including the start). */
  const closure = (key) => {
    const out = new Set();
    const stack = [...byKey.get(key).deps];
    while (stack.length) {
      const k = stack.pop();
      if (out.has(k) || k === key) continue;
      out.add(k);
      stack.push(...byKey.get(k).deps);
    }
    return out;
  };
  const closures = new Map(calcs.map((c) => [c.key, closure(c.key)]));
  const ownTc = (c) => Object.keys(c.a.functions).some((f) => TABLE_CALC_FN.test(f));
  const isTc = (c) => ownTc(c) || [...closures.get(c.key)].some((k) => ownTc(byKey.get(k)));
  const hasLod = (c) => c.a.lods.length > 0;

  // longest chain of calculations (cycles are cut)
  const chainMemo = new Map();
  const chain = (c, onPath = new Set()) => {
    if (chainMemo.has(c.key)) return chainMemo.get(c.key);
    onPath.add(c.key);
    let best = [];
    for (const k of c.deps) {
      if (onPath.has(k)) continue;
      const sub = chain(byKey.get(k), onPath);
      if (sub.length > best.length) best = sub;
    }
    onPath.delete(c.key);
    const res = [c.key, ...best];
    chainMemo.set(c.key, res);
    return res;
  };

  // --- usage -------------------------------------------------------------------
  const usage = new Map(calcs.map((c) => [c.key, { sheets: new Set(), indirect: new Set(), filters: new Set(), dsFilter: false }]));
  for (const ws of model.worksheets) {
    const direct = new Set();
    for (const u of ws.uses) {
      const k = `${u.ds}::${u.field}`;
      if (!byKey.has(k)) continue;
      direct.add(k);
      usage.get(k).sheets.add(ws.name);
      if (u.filter) usage.get(k).filters.add(ws.name);
    }
    for (const k of direct) for (const d of closures.get(k)) if (!direct.has(d)) usage.get(d).indirect.add(ws.name);
  }
  for (const ds of model.datasources) {
    for (const f of ds.filters) {
      const k = `${ds.name}::${f}`;
      if (!byKey.has(k)) continue;
      for (const d of [k, ...closures.get(k)]) usage.get(d).dsFilter = true;
    }
  }
  const dashboardsOf = (sheets) => model.dashboards.filter((d) => d.sheets.some((s) => sheets.has(s))).map((d) => d.name);
  const label = (k) => byKey.get(k).caption;

  // --- own findings ----------------------------------------------------------------
  for (const c of calcs) {
    const { a } = c;
    const ds = dsByName[c.ds];
    const F = [];
    const add = (code, severity, title, extra = {}) => F.push({ code, group: RULE[code].group, severity, title, why: RULE[code].why, ...extra });
    const fns = a.functions;
    const pick = (pred) => Object.fromEntries(Object.entries(fns).filter(([f]) => pred(f)));

    // string logic
    const casts = [];
    if (fns.DATEPARSE) casts.push("DATEPARSE");
    for (const dc of a.dateCasts) {
      const fromString = dc.strish || (dc.fields.length === 1 && !dc.fields[0].ds && /^string$/i.test(ds.fields[dc.fields[0].v]?.datatype || ""));
      if (fromString && !casts.includes(`${dc.fn} on text`)) casts.push(`${dc.fn} on text`);
    }
    if (casts.length) add("string-to-date", "high", `Text converted to a date: ${casts.join(", ")}`);
    if (a.branches >= 10) {
      add("long-branch", a.branches >= 25 ? "high" : "medium",
        `Long IF/CASE chain: ${a.branches} branches${a.stringCompares ? `, ${plural(a.stringCompares, "string comparison")}` : ""}`);
    } else if (a.stringCompares >= 5) {
      add("string-compare", "low", `${a.stringCompares} string comparisons`);
    }
    const rx = pick((f) => REGEX_FN.test(f));
    if (Object.keys(rx).length) add("regex", "medium", `Regular expression: ${fnList(rx)}`);
    const sf = pick((f) => STRING_FN.has(f));
    const nsf = Object.values(sf).reduce((s, n) => s + n, 0);
    if (nsf) add("string-functions", nsf >= 3 ? "medium" : "low", `String functions: ${fnList(sf)}`);

    // LOD
    const real = a.lods.filter((l) => l.type !== "TABLE");
    const nestedLodCalcs = c.lodDeps.filter((k) => [k, ...closures.get(k)].some((x) => hasLod(byKey.get(x))));
    if (a.lodDepth >= 2) add("lod-nested", "high", `Nested LOD expressions (${a.lodDepth} levels in this formula)`);
    if (nestedLodCalcs.length) add("lod-nested", "high", `LOD over another LOD: ${nestedLodCalcs.map(label).join(", ")}`);
    if (real.length) {
      const desc = real.map((l) => (l.type === "FIXED" ? `FIXED on ${plural(l.dims, "dimension")}` : l.type)).join(", ");
      add("lod", real.length >= 3 ? "high" : "medium", `LOD expression${real.length > 1 ? "s" : ""}: ${desc}`);
    } else if (a.lods.length) {
      add("lod-table", "low", "Table-scoped LOD expression");
    }

    // table calculations
    const tc = pick((f) => TABLE_CALC_FN.test(f));
    const tcOver = c.tcDeps.filter((k) => isTc(byKey.get(k)));
    if (a.tcNested.length) add("table-calc-nested", "high", `Nested table calculations: ${[...new Set(a.tcNested)].join(", ")}`);
    if (tcOver.length) add("table-calc-nested", "high", `Table calculation over ${tcOver.map(label).join(", ")}`);
    if (Object.keys(tc).length && !a.tcNested.length && !tcOver.length) add("table-calc", "medium", `Table calculation: ${fnList(tc)}`);

    // other
    const blended = [...new Set(a.refs.filter((r) => r.ds && r.ds !== c.ds && r.ds !== "Parameters").map((r) => r.ds))];
    if (blended.length) add("blending", "medium", `Blends in ${blended.map((d) => dsByName[d]?.caption || d).join(", ")}`);
    const ag = pick((f) => AGG_FN.has(f));
    if (Object.keys(ag).length) add("aggregation", "low", `Expensive aggregation: ${fnList(ag)}`);
    const vol = pick((f) => VOLATILE_FN.has(f));
    if (Object.keys(vol).length) add("volatile", "low", `Changes over time: ${Object.keys(vol).map((f) => `${f}()`).join(", ")}`);
    const uf = pick((f) => USER_FN.has(f));
    if (Object.keys(uf).length) add("user-function", "low", `User function: ${Object.keys(uf).join(", ")}`);

    c.findings = F;
    c.severity = maxSev(F.map((f) => f.severity));
    c.isTableCalc = isTc(c);
    c.chain = chain(c);
    c.depth = c.chain.length;
  }

  // --- findings that depend on other calcs and on usage ----------------------------
  for (const c of calcs) {
    const F = c.findings;
    const add = (code, severity, title) => F.push({ code, group: RULE[code].group, severity, title, why: RULE[code].why });
    if (c.depth >= 4) add("deep-chain", c.depth >= 6 ? "medium" : "low", `Chain of ${c.depth} calculations: ${c.chain.map(label).join(" → ")}`);
    const costly = [...closures.get(c.key)].map((k) => byKey.get(k)).filter((d) => rank(d.severity) >= rank("medium"));
    if (costly.length) add("inherits", "low", `Builds on ${costly.map((d) => `${d.caption} (${d.severity})`).join(", ")}`);

    const u = usage.get(c.key);
    c.usage = {
      sheets: [...u.sheets], indirect: [...u.indirect], filters: [...u.filters], dsFilter: u.dsFilter,
      dashboards: dashboardsOf(new Set([...u.sheets, ...u.indirect])),
    };
    c.used = hasSheets ? (u.sheets.size > 0 || u.indirect.size > 0 || u.dsFilter) : null;
    if (c.isTableCalc && u.filters.size) add("table-calc-filter", "medium", `Table calculation used as a filter on ${[...u.filters].join(", ")}`);
    if (c.used === false && !c.published) add("unused", "low", "Not used in any sheet, filter or other used calculation");

    c.severity = maxSev(F.filter((f) => f.code !== "unused").map((f) => f.severity));
    // priority: severity weighted by usage
    let p = rank(c.severity);
    const reach = u.sheets.size + u.indirect.size;
    if (p > 0 && c.used && (reach >= 3 || u.filters.size || u.dsFilter)) p = Math.min(3, p + 1);
    if (c.used === false && F.length) p = 1; // unused: at most low, but still listed
    c.priority = SEVERITIES[p];
    c.highlight = Object.keys(c.a.functions).filter((f) =>
      f === "DATEPARSE" || REGEX_FN.test(f) || STRING_FN.has(f) || TABLE_CALC_FN.test(f) || AGG_FN.has(f) || VOLATILE_FN.has(f) || USER_FN.has(f));
  }

  const reach = (c) => c.usage.sheets.length + c.usage.indirect.length;
  calcs.sort((x, y) => rank(y.priority) - rank(x.priority) || rank(y.severity) - rank(x.severity)
    || reach(y) - reach(x) || x.caption.localeCompare(y.caption));

  const count = (pred) => calcs.filter(pred).length;
  const summary = {
    kind: model.kind,
    calculations: calcs.length,
    datasources: model.datasources.filter((d) => !d.isParameters).length,
    worksheets: model.worksheets.length,
    dashboards: model.dashboards.length,
    high: count((c) => c.priority === "high"),
    medium: count((c) => c.priority === "medium"),
    low: count((c) => c.priority === "low"),
    unused: count((c) => c.used === false),
  };
  return { calcs, summary, worksheets: model.worksheets.map((w) => w.name), dashboards: model.dashboards };
}

/** Plain objects for the JSON download (no internal analysis fields). */
export function calcsToJSON(result) {
  return {
    summary: result.summary,
    calculations: result.calcs.map((c) => ({
      name: c.caption, internal_name: c.name, datasource: c.dsCaption, priority: c.priority, severity: c.severity,
      findings: c.findings.map(({ code, group, severity, title }) => ({ code, group, severity, title })),
      formula: c.formula, depth: c.depth,
      uses: c.deps.map((k) => k.split("::").slice(1).join("::")), used_by: c.dependents.map((k) => k.split("::").slice(1).join("::")),
      usage: c.usage, used: c.used, table_calculation: c.isTableCalc, published: c.published, adhoc_in: c.adhoc || undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// Exports: Markdown and CSV
// ---------------------------------------------------------------------------

const mdCell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fence = (s) => {
  const ticks = "`".repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${s}\n${ticks}`;
};

function usageLine(c) {
  if (c.used === null) return "unknown (data source file, no sheets)";
  const parts = [];
  if (c.usage.sheets.length) parts.push(c.usage.sheets.join(", "));
  if (c.usage.indirect.length) parts.push(`via other calculations: ${c.usage.indirect.join(", ")}`);
  if (c.usage.dsFilter) parts.push("data source filter (every sheet)");
  return parts.join("; ") || (c.published ? "not used (published data source)" : "not used");
}

export function renderCalcMarkdown(result, title) {
  const { calcs, summary: s } = result;
  const L = [`# Expensive calculations: ${title}`, ""];
  L.push(`${plural(s.calculations, "calculation")} in ${plural(s.datasources, "data source")}` +
    (s.kind === "workbook" ? `, ${plural(s.worksheets, "sheet")}, ${plural(s.dashboards, "dashboard")}` : "") + ".", "");
  L.push(`| Priority | Count |`, `|---|---|`, `| High | ${s.high} |`, `| Medium | ${s.medium} |`, `| Low | ${s.low} |`);
  if (s.kind === "workbook") L.push(`| Not used | ${s.unused} |`);
  L.push("");
  const flagged = calcs.filter((c) => c.findings.length);
  if (!flagged.length) return L.concat("No expensive calculations found.", "").join("\n");
  L.push("## Overview", "", "| Priority | Calculation | Data source | Findings | Used in |", "|---|---|---|---|---|");
  for (const c of flagged) {
    L.push(`| ${c.priority} | ${mdCell(c.caption)} | ${mdCell(c.dsCaption)} | ${mdCell(c.findings.map((f) => f.title).join("; "))} | ${mdCell(usageLine(c))} |`);
  }
  L.push("", "## Details", "");
  for (const c of flagged) {
    L.push(`### ${c.caption}`, "", `Priority **${c.priority}** (severity ${c.severity}) · ${c.dsCaption}${c.isTableCalc ? " · table calculation" : ""}`, "");
    for (const f of c.findings) L.push(`- **${f.title}** (${f.severity}, ${f.group}). ${f.why}`);
    L.push("", `Used in: ${usageLine(c)}`);
    if (c.usage.filters.length) L.push("", `Filter on: ${c.usage.filters.join(", ")}`);
    if (c.usage.dashboards.length) L.push("", `Dashboards: ${c.usage.dashboards.join(", ")}`);
    L.push("", fence(c.displayFormula), "");
  }
  return L.join("\n");
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function renderCalcCsv(result) {
  const head = ["priority", "severity", "calculation", "data source", "findings", "groups", "sheets", "via other calculations",
    "filter on", "data source filter", "dashboards", "used", "depth", "table calculation", "formula"];
  const rows = result.calcs.map((c) => [
    c.priority, c.severity, c.caption, c.dsCaption, c.findings.map((f) => f.title).join("; "),
    [...new Set(c.findings.map((f) => f.group))].join("; "), c.usage.sheets.join("; "), c.usage.indirect.join("; "),
    c.usage.filters.join("; "), c.usage.dsFilter ? "yes" : "", c.usage.dashboards.join("; "),
    c.used === null ? "" : c.used ? "yes" : "no", c.depth, c.isTableCalc ? "yes" : "", c.displayFormula,
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
