// TDS Lens - checks: factual findings that help debug and document a data source.
// Each finding states what was found (evidence), why it can matter, and which
// tables/relationships it is about (targets), so the page can highlight them.
// Nothing here guesses at intent: "warning" = worth verifying, "info" = worth knowing.
import { displayName, fieldLabel, joinClause, physicalTableNames, stripBrackets } from "./parse.js";

const NAME_WORDS = ["naam", "name", "omschrijving", "description", "desc", "label", "titel", "title", "tekst", "text"];
const ID_WORDS = ["id", "key", "code", "nr", "nummer", "number", "no", "fk", "pk", "sk", "guid", "uuid"];

/** Last word of a field name: "AccountID" -> "id", "klant_naam" -> "naam", "BrancheFK" -> "fk". */
export function lastWord(field) {
  const words = field
    .replace(/\s*\(.*\)\s*$/, "")                // "Region (People)" -> "Region"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")      // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "";
  const last = words[words.length - 1].toLowerCase();
  // Dutch/English compounds written as one word: "accountnaam", "klantnummer", "contractid"
  for (const w of [...NAME_WORDS, ...ID_WORDS].sort((a, b) => b.length - a.length)) {
    if (last.length > w.length + 2 && last.endsWith(w)) return w;
  }
  return last;
}
const isNameLike = (f) => NAME_WORDS.includes(lastWord(f));
const isIdLike = (f) => ID_WORDS.includes(lastWord(f));

/** Pairs of compared fields in a predicate: "[a] = [b] AND [T].[c] = [U].[d]". */
export function fieldPairs(expr) {
  const field = String.raw`\[[^\]]+\](?:\.\[[^\]]+\])?`;
  const re = new RegExp(`(${field})\\s*(=|<>|!=|<=|>=|<|>)\\s*(${field})`, "g");
  return [...expr.matchAll(re)].map((m) => [m[1], m[3]]);
}

const bare = (f) => stripBrackets(f.split("].[").pop().replace(/^\[/, "").replace(/\]$/, ""));

const PERSONAL = /^[a-z]+[._-][a-z]+(\d+)?$|@/i;
const SERVICE = /svc|service|srv|sys|app|etl|tableau|bi[_-]|report|read|batch|admin|system|\$/i;

export function runChecks(ds) {
  const out = [];
  const names = Object.fromEntries(ds.tables.map((t) => [t.id, displayName(t)]));
  const conns = ds.connCaptions || {};

  // column lookups: by local field name, and by physical "table.column"
  const byName = {}, byPhysical = {};
  for (const t of ds.tables) {
    for (const c of t.columns) {
      byName[c.name] = c;
      byPhysical[`${c.parent}.${c.remote_name}`] = c;
    }
  }
  const relLabel = (r) => `${names[r.first.table_id] ?? r.first.table} → ${names[r.second.table_id] ?? r.second.table}`;

  // --- join fields: name vs ID, and data type mismatches -------------------------
  const joinFieldChecks = (pairs, lookup, where, target) => {
    for (const [a, b] of pairs) {
      const fa = bare(a), fb = bare(b);
      if ((isNameLike(fa) && isIdLike(fb)) || (isIdLike(fa) && isNameLike(fb))) {
        out.push({
          severity: "warning", code: "name-vs-id",
          title: "A name field is joined to an ID field",
          detail: `${where}: ${fa} = ${fb}`,
          why: "The field names suggest a descriptive name matched against a key. Check that both fields hold the same kind of value (in some sources, such as Salesforce exports, a column labelled \"name\" contains the ID). If they don't, the join finds few or no matches.",
          targets: [target],
        });
      }
      const ca = lookup(a), cb = lookup(b);
      if (ca && cb && ca.datatype && cb.datatype && ca.datatype !== cb.datatype) {
        out.push({
          severity: "warning", code: "type-mismatch",
          title: "Join fields have different data types",
          detail: `${where}: ${fa} (${ca.datatype}) = ${fb} (${cb.datatype})`,
          why: "Values of different types must be converted before they can match, which can be slow and can silently miss matches (for example leading zeros or decimals).",
          targets: [target],
        });
      }
    }
  };

  ds.relationships.forEach((r, idx) => {
    // relationship predicates use the data source's field names, e.g. [Region (People)]
    joinFieldChecks(fieldPairs(r.predicate), (f) => byName[stripBrackets(f)], `Relationship ${relLabel(r)}`, { rel: idx });
  });

  const walkJoins = (node, t) => {
    if (!node) return;
    if (node.kind === "join") {
      joinFieldChecks(fieldPairs(node.clause), (f) => {
        const m = f.match(/^\[([^\]]+)\]\.\[([^\]]+)\]$/);
        return m ? byPhysical[`${m[1]}.${m[2]}`] : null;
      }, `Join inside ${names[t.id]} (${joinClause(node)})`, { table: t.id });
    }
    node.children.forEach((c) => walkJoins(c, t));
  };
  ds.tables.forEach((t) => walkJoins(t.physical, t));

  // --- performance options never set --------------------------------------------
  const defaults = ds.relationships
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.first.cardinality === "Many" && r.second.cardinality === "Many" &&
      !r.first.referential_integrity.startsWith("All") && !r.second.referential_integrity.startsWith("All"));
  if (defaults.length) {
    out.push({
      severity: "info", code: "default-performance-options",
      title: `${defaults.length} of ${ds.relationships.length} relationships use Tableau's default performance options`,
      detail: defaults.map(({ r }) => relLabel(r)).join("; "),
      why: "Many-to-Many with \"some records match\" is what Tableau sets when nobody changes it. The results are always correct, but if you know the real cardinality and that every record has a match, setting it lets Tableau leave out unneeded joins and build faster queries.",
      targets: defaults.map(({ idx }) => ({ rel: idx })),
    });
  }

  // --- custom SQL and large physical join trees ----------------------------------
  for (const t of ds.tables) {
    const customSql = [];
    const collect = (n) => { if (!n) return; if (n.kind === "custom-sql") customSql.push(n.name); n.children.forEach(collect); };
    collect(t.physical);
    if (customSql.length) {
      out.push({
        severity: "info", code: "custom-sql",
        title: `${names[t.id]} uses custom SQL`,
        detail: `Custom SQL: ${customSql.join(", ")}`,
        why: "Tableau runs custom SQL as a subquery and cannot remove unneeded parts from it, so it is often slower than tables or relationships. Its logic is also only visible here, not in the database.",
        targets: [{ table: t.id }],
      });
    }
    const n = physicalTableNames(t.physical).size;
    if (n >= 3) {
      out.push({
        severity: "info", code: "physical-join-tree",
        title: `${names[t.id]} joins ${n} tables in the physical layer`,
        detail: [...physicalTableNames(t.physical)].join(", "),
        why: "Joins inside one logical table are always run in full, even when a view needs only one of the tables. Relationships between separate logical tables let Tableau query only what a view needs.",
        targets: [{ table: t.id }],
      });
    }
  }

  // --- connections ---------------------------------------------------------------
  if (ds.connections.length > 1) {
    out.push({
      severity: "info", code: "cross-database",
      title: `This data source combines ${ds.connections.length} connections`,
      detail: ds.connections.map((c) => `${c.caption || c.name} (${c.cls})`).join(", "),
      why: "Data from different connections is combined by Tableau itself rather than by a database, which can be slow for large tables.",
      targets: [],
    });
  }
  for (const c of ds.connections) {
    const label = c.caption || c.name;
    if (c.username && PERSONAL.test(c.username) && !SERVICE.test(c.username)) {
      out.push({
        severity: "warning", code: "personal-login",
        title: `Connection ${label} signs in with what looks like a personal account`,
        detail: `Login: ${c.username}`,
        why: "If this person leaves or changes their password, the data source stops working. A service account avoids that.",
        targets: [],
      });
    }
    if (c.initial_sql) {
      out.push({
        severity: "info", code: "initial-sql",
        title: `Connection ${label} runs Initial SQL`,
        detail: c.initial_sql.split("\n")[0] + (c.initial_sql.includes("\n") ? " …" : ""),
        why: "It runs every time a connection is opened, before any query. Worth documenting, because it can change results (for example isolation level or session settings).",
        targets: [],
      });
    }
  }

  // --- filters that change which rows exist ----------------------------------------
  if (ds.filters.length) {
    out.push({
      severity: "info", code: "data-source-filters",
      title: `${ds.filters.length} data source filter${ds.filters.length === 1 ? "" : "s"}`,
      detail: ds.filters.map((f) => fieldLabel(ds, f.column)).join(", "),
      why: "These filters apply to every view built on this data source. Totals in Tableau can therefore differ from the database.",
      targets: [],
    });
  }
  if (ds.extract && ds.extract.filters && ds.extract.filters.length) {
    out.push({
      severity: "info", code: "extract-filters",
      title: "The extract only contains filtered rows",
      detail: ds.extract.filters.map((f) => fieldLabel(ds, f)).join(", "),
      why: "Rows that don't pass these filters are not in the extract at all, so they can't be shown or counted in any view.",
      targets: [],
    });
  }

  // the same finding in several places becomes one finding with one evidence line each
  const merged = [];
  for (const f of out) {
    const same = merged.find((m) => m.code === f.code && m.title === f.title);
    if (same) {
      same.detail += `\n${f.detail}`;
      same.targets.push(...f.targets);
    } else merged.push({ ...f, targets: [...f.targets] });
  }
  for (const m of merged) {
    const n = m.detail.split("\n").length;
    if (n > 1) m.title += ` (${n}×)`;
  }
  const order = { warning: 0, info: 1 };
  return merged.sort((a, b) => order[a.severity] - order[b.severity]);
}

