#!/usr/bin/env python3
"""
tds_structure.py - show the structure of a Tableau data source.

Reads a .tds / .tdsx (or .twb / .twbx) from disk, or fetches a published data
source straight from Tableau Server / Tableau Cloud, and prints:

  * connections (class, server, database, initial SQL, query banding, TDC customizations)
  * logical tables (the relationship model, 2020.2+) and the physical layer
    underneath each one (tables, joins + join clauses, unions, custom SQL)
  * relationships between logical tables, including the performance options
    (cardinality / unique key, referential integrity)
  * extract settings, data source filters
  * optionally the columns per table

Server mode does NOT download the data: it asks the REST API for the data source
content with includeExtract=False, so only the XML definition (a few KB) is
transferred, and it is parsed in memory - nothing is written to disk.

Usage
-----
  Local file:
    python tds_structure.py Superstore.tdsx
    python tds_structure.py Superstore.tds --columns --format mermaid

  Tableau Server / Cloud (settings read from env vars or a .env file:
  TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET):
    python tds_structure.py --list
    python tds_structure.py -d "Superstore"

  or explicitly:
    export TABLEAU_PAT_NAME=my-token
    export TABLEAU_PAT_SECRET=xxxxxxxx
    python tds_structure.py --server https://tableau.example.com --site Sales \\
        --datasource "Superstore" [--project "Finance"]
    python tds_structure.py --server https://tableau.example.com --site Sales --list

  Username / password instead of a PAT:
    export TABLEAU_PASSWORD=...
    python tds_structure.py --server ... --username jdoe --datasource ...

Output formats: text (default), json, mermaid (ER diagram).
Diagram: --image model.png (or .svg, with hover tooltips) draws the relationships the
way Tableau's data source canvas does; add --edge-labels to show the join fields.

Requires: Python 3.9+, and `pip install tableauserverclient` for server mode.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict, dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# XML helpers
#
# Tableau writes feature-flagged tags/attributes such as
#   <_.fcp.ObjectModelEncapsulateLegacy.true...object-graph>
#   <_.fcp.ObjectModelEncapsulateLegacy.false...relation ...>
# The ".true..." variant is the current definition, the ".false..." variant is a
# fallback for older Tableau versions, so we strip the prefix and skip ".false".
# ---------------------------------------------------------------------------


def lname(name: str) -> str:
    return name.split("...")[-1]


def disabled(name: str) -> bool:
    return "..." in name and name.split("...")[0].endswith(".false")


def attrs(el: ET.Element) -> dict:
    return {lname(k): v for k, v in el.attrib.items() if not disabled(k)}


def kids(el: Optional[ET.Element], name: Optional[str] = None) -> list[ET.Element]:
    if el is None:
        return []
    return [c for c in el if not disabled(c.tag) and (name is None or lname(c.tag) == name)]


def kid(el: Optional[ET.Element], name: str) -> Optional[ET.Element]:
    found = kids(el, name)
    return found[0] if found else None


def descendants(el: ET.Element, name: str) -> list[ET.Element]:
    """Matching elements below el, not descending into disabled (".false...") legacy elements."""
    out = []
    for c in el:
        if disabled(c.tag):
            continue
        if lname(c.tag) == name:
            out.append(c)
        out += descendants(c, name)
    return out


def strip_brackets(s: str) -> str:
    return s[1:-1] if s.startswith("[") and s.endswith("]") else s


BINARY_OPS = {"=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/"}


def expr_to_str(el: Optional[ET.Element]) -> str:
    """Render a Tableau <expression> tree (join clauses, relationship predicates)."""
    if el is None:
        return ""
    op = el.get("op", "")
    children = [c for c in el if lname(c.tag) == "expression"]
    if not children:
        return op
    parts = [expr_to_str(c) for c in children]
    if op in BINARY_OPS and len(parts) == 2:
        return f"{parts[0]} {op} {parts[1]}"
    if op.upper() in ("AND", "OR"):
        return f" {op.upper()} ".join(f"({p})" if " AND " in p or " OR " in p else p for p in parts)
    return f"{op}({', '.join(parts)})"


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


@dataclass
class Connection:
    name: str
    caption: str
    cls: str
    server: str = ""
    port: str = ""
    dbname: str = ""
    schema: str = ""
    username: str = ""
    authentication: str = ""
    initial_sql: str = ""
    query_band: str = ""
    customizations: dict = field(default_factory=dict)
    other: dict = field(default_factory=dict)


@dataclass
class Column:
    name: str
    remote_name: str
    datatype: str
    remote_type: str = ""
    parent: str = ""


@dataclass
class PhysicalNode:
    kind: str  # table | join | union | custom-sql | collection | other
    name: str = ""
    table: str = ""
    connection: str = ""
    join_type: str = ""
    clause: str = ""
    sql: str = ""
    children: list = field(default_factory=list)
    other: dict = field(default_factory=dict)


@dataclass
class LogicalTable:
    id: str
    caption: str
    physical: Optional[PhysicalNode]
    contexts: list = field(default_factory=list)
    columns: list = field(default_factory=list)
    role: str = ""  # fact / dimension (multi-fact models only)


@dataclass
class EndPoint:
    table_id: str
    table: str
    cardinality: str  # One / Many
    unique_key_source: str  # "user" / "database" / "" (default)
    referential_integrity: str  # "All records match" / "Some records match"
    raw: dict = field(default_factory=dict)


@dataclass
class Relationship:
    first: EndPoint
    second: EndPoint
    predicate: str
    predicate_resolved: str


@dataclass
class DataSource:
    name: str
    caption: str
    version: str
    connections: list = field(default_factory=list)
    model: str = ""  # "relationships" or "single logical table (legacy)"
    tables: list = field(default_factory=list)
    relationships: list = field(default_factory=list)
    extract: dict = field(default_factory=dict)
    filters: list = field(default_factory=list)
    calculated_fields: int = 0
    other_settings: dict = field(default_factory=dict)
    server_info: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

CONN_KNOWN = {
    "class", "server", "port", "dbname", "schema", "username", "authentication",
    "one-time-sql", "query-band-spec", "caption", "name",
}


def parse_connection(name: str, caption: str, c: ET.Element) -> Connection:
    a = attrs(c)
    conn = Connection(
        name=name,
        caption=caption or a.get("caption", ""),
        cls=a.get("class", ""),
        server=a.get("server", ""),
        port=a.get("port", ""),
        dbname=a.get("dbname", ""),
        schema=a.get("schema", ""),
        username=a.get("username", ""),
        authentication=a.get("authentication", ""),
        initial_sql=a.get("one-time-sql", ""),
        query_band=a.get("query-band-spec", ""),
    )
    for cust in descendants(c, "customization"):
        conn.customizations[cust.get("name", "")] = cust.get("value", "")
    conn.other = {
        k: v for k, v in a.items()
        if k not in CONN_KNOWN and v not in ("", None) and "password" not in k.lower()
    }
    return conn


def parse_relation(rel: ET.Element) -> PhysicalNode:
    a = attrs(rel)
    typ = a.get("type", "")
    node = PhysicalNode(kind=typ or "other", name=a.get("name", ""), connection=a.get("connection", ""))
    if typ == "table":
        node.table = a.get("table", "")
    elif typ == "text":
        node.kind = "custom-sql"
        node.sql = (rel.text or "").strip()
    elif typ == "join":
        node.join_type = a.get("join", "inner")
        clause = kid(rel, "clause")
        node.clause = expr_to_str(kid(clause, "expression"))
    elif typ == "union":
        node.other["union-all"] = a.get("all", "")
    known = {"type", "name", "connection", "table", "join", "all"}
    node.other.update({k: v for k, v in a.items() if k not in known})
    node.children = [parse_relation(c) for c in kids(rel, "relation")]
    return node


def physical_table_names(node: Optional[PhysicalNode]) -> set[str]:
    if node is None:
        return set()
    out = {node.name} if node.name else set()
    for c in node.children:
        out |= physical_table_names(c)
    return out


def parse_datasource(ds: ET.Element) -> DataSource:
    a = attrs(ds)
    out = DataSource(
        name=a.get("name", ""),
        caption=a.get("caption") or a.get("formatted-name") or a.get("name", ""),
        version=a.get("version", ""),
    )

    top_conn = kid(ds, "connection")
    conn_captions: dict[str, str] = {}

    # --- connections -------------------------------------------------------
    if top_conn is not None:
        if top_conn.get("class") == "federated":
            for nc in descendants(top_conn, "named-connection"):
                inner = kid(nc, "connection")
                if inner is not None:
                    c = parse_connection(nc.get("name", ""), nc.get("caption", ""), inner)
                    out.connections.append(c)
                    conn_captions[c.name] = c.caption or c.cls
        else:
            c = parse_connection(top_conn.get("class", ""), "", top_conn)
            out.connections.append(c)
        if top_conn.get("class") == "sqlproxy":
            out.other_settings["note"] = (
                "This is a reference to a PUBLISHED data source (sqlproxy). Point the "
                "script at the published data source itself to see its tables/relationships."
            )

    # --- field-name map: [Region (People)] -> [People].[Region] -------------
    col_map: dict[str, str] = {}
    for m in descendants(top_conn, "map") if top_conn is not None else []:
        col_map[m.get("key", "")] = m.get("value", "")

    # --- columns from metadata-records --------------------------------------
    columns_by_object: dict[str, list[Column]] = {}
    columns_by_parent: dict[str, list[Column]] = {}
    if top_conn is not None:
        for mr in descendants(top_conn, "metadata-record"):
            if mr.get("class") != "column":
                continue
            def t(n):
                e = kid(mr, n)
                return (e.text or "").strip() if e is not None else ""
            col = Column(
                name=strip_brackets(t("local-name")),
                remote_name=t("remote-name"),
                datatype=t("local-type"),
                remote_type=t("remote-type"),
                parent=strip_brackets(t("parent-name")),
            )
            obj = strip_brackets(t("object-id"))
            if obj:
                columns_by_object.setdefault(obj, []).append(col)
            columns_by_parent.setdefault(col.parent, []).append(col)

    # --- logical layer (object graph, 2020.2+) -------------------------------
    graph = kid(ds, "object-graph")
    if graph is not None:
        multi_fact = any("ObjectModelSharedDimensions.true" in e.tag for e in graph.iter())
        out.model = ("multi-fact relationships (shared dimensions, 2024.2+)" if multi_fact
                     else "relationships (logical layer, 2020.2+)")
        for obj in kids(kid(graph, "objects"), "object"):
            oid = obj.get("id", "")
            physical = None
            contexts = []
            for props in kids(obj, "properties"):
                ctx = props.get("context", "")
                contexts.append(ctx or "live")
                rel = kid(props, "relation")
                if rel is not None and (physical is None or ctx == ""):
                    physical = parse_relation(rel)
            lt = LogicalTable(id=oid, caption=obj.get("caption", oid), physical=physical, contexts=contexts)
            lt.columns = list(columns_by_object.get(oid, []))
            lt.columns += [  # columns without an object-id: match on their physical table
                c for n in physical_table_names(physical) for c in columns_by_parent.get(n, [])
                if c not in lt.columns and not any(c in v for v in columns_by_object.values())
            ]
            out.tables.append(lt)

        captions = {t.id: t.caption for t in out.tables}
        for r in kids(kid(graph, "relationships"), "relationship"):
            pred = kid(r, "expression")
            predicate = expr_to_str(pred)
            resolved = re.sub(r"\[[^\]]+\]", lambda m: col_map.get(m.group(0), m.group(0)), predicate)
            ends = []
            for tag in ("first-end-point", "second-end-point"):
                ep = kid(r, tag)
                ea = attrs(ep) if ep is not None else {}
                oid = ea.get("object-id", "")
                unique = ea.get("unique-key", "false") == "true"
                db_set = ea.get("is-db-set-unique-key", "false") == "true"
                # "Referential integrity: All records match" is stored as guaranteed-value='true'
                all_match = ea.get("guaranteed-value", "false") == "true"
                ends.append(EndPoint(
                    table_id=oid,
                    table=captions.get(oid, oid),
                    cardinality="One" if unique else "Many",
                    unique_key_source=("database" if db_set else "user") if unique else "",
                    referential_integrity="All records match" if all_match else "Some records match",
                    raw=ea,
                ))
            out.relationships.append(Relationship(ends[0], ends[1], predicate, resolved))

        if multi_fact:
            one_side = {ep.table_id for r in out.relationships for ep in (r.first, r.second) if ep.cardinality == "One"}
            for t in out.tables:
                t.role = "dimension" if t.id in one_side else "fact"

    # --- legacy single logical table -----------------------------------------
    elif top_conn is not None:
        rel = kid(top_conn, "relation")
        if rel is not None:
            out.model = "single logical table (pre-2020.2 / physical joins only)"
            physical = parse_relation(rel)
            lt = LogicalTable(id=physical.name or "table", caption=physical.name or "table", physical=physical)
            lt.columns = [c for cols in columns_by_parent.values() for c in cols]
            out.tables.append(lt)

    # --- extract -------------------------------------------------------------
    ext = kid(ds, "extract")
    if ext is not None:
        ea = attrs(ext)
        info: dict = {"enabled": ea.get("enabled", ""), "attributes": ea}
        ec = kid(ext, "connection")
        if ec is not None:
            eca = {k: v for k, v in attrs(ec).items() if "password" not in k.lower()}
            info["connection"] = eca
            ext_tables = [r for r in descendants(ec, "relation") if r.get("type") == "table"]
            info["storage"] = "multiple tables" if len(ext_tables) > 1 else "single table"
            info["tables"] = [r.get("table", r.get("name", "")) for r in ext_tables]
            refresh = kid(ec, "refresh")
            if refresh is None:
                refresh = kid(ext, "refresh")
            if refresh is not None:
                info["refresh"] = attrs(refresh)
                events = kids(refresh, "refresh-event")
                if events:
                    info["last_refresh_event"] = attrs(events[-1])
                    info["refresh_events"] = len(events)
        flt = descendants(ext, "filter")
        if flt:
            info["filters"] = [f.get("column", "") for f in flt]
        out.extract = info

    # --- data source filters (applied to every query) ------------------------
    for f in kids(ds, "filter"):
        out.filters.append({"column": f.get("column", ""), "class": f.get("class", ""),
                            "context": f.get("filter-group", "")})

    # --- misc ------------------------------------------------------------------
    out.calculated_fields = sum(1 for c in kids(ds, "column") if kid(c, "calculation") is not None)
    for key, val in attrs(ds).items():
        if any(s in key for s in ("referential", "integrity", "cull", "unique")):
            out.other_settings[key] = val
    if top_conn is not None:
        for key, val in attrs(top_conn).items():
            if any(s in key for s in ("referential", "integrity", "cull", "unique")):
                out.other_settings[f"connection.{key}"] = val

    # connection captions for display
    out.other_settings.setdefault("_conn_captions", conn_captions)
    return out


def parse_xml(xml_bytes: bytes) -> list[DataSource]:
    root = ET.fromstring(xml_bytes)
    tag = lname(root.tag)
    if tag == "datasource":
        return [parse_datasource(root)]
    if tag == "workbook":
        return [
            parse_datasource(d) for d in kids(kid(root, "datasources"), "datasource")
            if d.get("name") != "Parameters"
        ]
    raise ValueError(f"Unexpected root element <{root.tag}>, not a Tableau data source")


def read_definition(data: bytes, filename: str) -> bytes:
    """Return the XML of a .tds/.twb, or extract it from a .tdsx/.twbx zip (in memory)."""
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for ext in (".tds", ".twb"):
                names = [n for n in z.namelist() if n.lower().endswith(ext) and "/" not in n.strip("/")]
                names = names or [n for n in z.namelist() if n.lower().endswith(ext)]
                if names:
                    return z.read(names[0])
        raise ValueError(f"No .tds/.twb found inside {filename}")
    return data


# ---------------------------------------------------------------------------
# Tableau Server
# ---------------------------------------------------------------------------

LUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def server_sign_in(args):
    try:
        import tableauserverclient as TSC
    except ImportError:
        sys.exit("Server mode needs tableauserverclient:  pip install tableauserverclient")

    token_name = args.token_name or os.environ.get("TABLEAU_PAT_NAME")
    token_secret = os.environ.get("TABLEAU_PAT_SECRET")
    if args.username:
        password = os.environ.get("TABLEAU_PASSWORD")
        if not password:
            import getpass
            password = getpass.getpass(f"Password for {args.username}: ")
        auth = TSC.TableauAuth(args.username, password, site_id=args.site)
    elif token_name and token_secret:
        auth = TSC.PersonalAccessTokenAuth(token_name, token_secret, site_id=args.site)
    else:
        sys.exit("Provide TABLEAU_PAT_NAME + TABLEAU_PAT_SECRET env vars, or --username "
                 "(password via TABLEAU_PASSWORD or prompt).")

    server = TSC.Server(args.server, use_server_version=True)
    if args.insecure:
        server.add_http_options({"verify": False})
    server.auth.sign_in(auth)
    return TSC, server


def server_list(args) -> None:
    TSC, server = server_sign_in(args)
    try:
        rows = [(d.project_name or "", d.name, d.id, d.datasource_type or "", "extract" if d.has_extracts else "live")
                for d in TSC.Pager(server.datasources)]
    finally:
        server.auth.sign_out()
    rows.sort(key=lambda r: (r[0].lower(), r[1].lower()))
    w0 = max([len(r[0]) for r in rows] + [7])
    w1 = max([len(r[1]) for r in rows] + [4])
    print(f"{'PROJECT':<{w0}}  {'NAME':<{w1}}  {'LUID':<36}  TYPE")
    for r in rows:
        print(f"{r[0]:<{w0}}  {r[1]:<{w1}}  {r[2]:<36}  {r[3]} ({r[4]})")


def server_fetch(args) -> tuple[bytes, dict]:
    TSC, server = server_sign_in(args)
    try:
        if LUID_RE.match(args.datasource):
            try:
                item = server.datasources.get_by_id(args.datasource)
            except TSC.ServerResponseError as e:
                sys.exit(f"Data source {args.datasource} not found on site '{args.site}': {e.summary}")
        else:
            opts = TSC.RequestOptions()
            opts.filter.add(TSC.Filter(TSC.RequestOptions.Field.Name,
                                       TSC.RequestOptions.Operator.Equals, args.datasource))
            matches = list(TSC.Pager(server.datasources, opts))
            if args.project:
                matches = [d for d in matches if d.project_name == args.project]
            if not matches:
                sys.exit(f"No data source named '{args.datasource}' found"
                         + (f" in project '{args.project}'" if args.project else ""))
            if len(matches) > 1:
                lines = "\n".join(f"  {d.id}  project={d.project_name}" for d in matches)
                sys.exit(f"'{args.datasource}' is ambiguous, use --project or a LUID:\n{lines}")
            item = matches[0]

        # Only the definition is transferred (includeExtract=False), kept in memory.
        buf = io.BytesIO()
        server.datasources.download(item.id, filepath=buf, include_extract=False)
        info = {
            "server": args.server, "site": args.site, "luid": item.id, "name": item.name,
            "project": item.project_name, "owner_id": item.owner_id,
            "type": item.datasource_type, "has_extracts": item.has_extracts,
            "certified": item.certified, "updated_at": str(item.updated_at or ""),
            "webpage_url": getattr(item, "webpage_url", "") or "",
        }
        return buf.getvalue(), info
    finally:
        server.auth.sign_out()


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


USE_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def bold(s: str) -> str:
    return f"\033[1m{s}\033[0m" if USE_COLOR else s


def dim(s: str) -> str:
    return f"\033[2m{s}\033[0m" if USE_COLOR else s


def heavy_rule(title: str = "") -> list[str]:
    return ["═" * 100, bold(title), "═" * 100] if title else ["═" * 100]


def section(title: str) -> list[str]:
    return ["", "─" * 100, bold(title), "─" * 100]


def leaf_connections(node: Optional[PhysicalNode]) -> list[str]:
    if node is None:
        return []
    out = [node.connection] if node.connection else []
    for c in node.children:
        out += [x for x in leaf_connections(c) if x not in out]
    return out


def simple_table(node: Optional[PhysicalNode]) -> bool:
    return node is not None and node.kind == "table" and not node.children


def unqualify(expr: str) -> str:
    """[Tbl].[Col] = [Tbl2].[Col2]  ->  Col = Col2"""
    return re.sub(r"\[[^\]]+\]\.\[([^\]]+)\]", r"\1", expr).replace("[", "").replace("]", "")


def readable(expr: str) -> str:
    """[Tbl].[Col] = [Tbl2].[Col2]  ->  Tbl.Col = Tbl2.Col2"""
    return re.sub(r"\[([^\]]+)\]\.\[([^\]]+)\]", r"\1.\2", expr).replace("[", "").replace("]", "")


def render_physical(node: PhysicalNode, conns: dict, indent: str, lines: list[str], show_conn: bool) -> None:
    conn = dim(f"  @ {conns.get(node.connection, node.connection)}") if show_conn and node.connection else ""
    if node.kind == "table":
        tname = strip_brackets(node.table.split(".")[-1])
        alias = node.name and tname != node.name and not tname.startswith(node.name)
        lines.append(f"{indent}table  {unqualify(node.table) or node.name}"
                     + (dim(f"  (alias {node.name})") if alias else "") + conn)
    elif node.kind == "custom-sql":
        lines.append(f"{indent}custom SQL  '{node.name}'{conn}")
        lines += [f"{indent}  │ {l}" for l in node.sql.splitlines()]
    elif node.kind == "join":
        clause = node.clause
        for alias, full in table_aliases(node).items():  # Tableau shortens aliases to 30 chars
            if full != alias and full.startswith(alias):
                clause = clause.replace(f"[{alias}].", f"[{full}].")
        lines.append(f"{indent}{node.join_type.upper()} JOIN on {readable(clause)}")
    elif node.kind == "union":
        lines.append(f"{indent}UNION '{node.name}'")
    else:
        lines.append(f"{indent}{node.kind} {node.name}{conn}")
    extra = {k: v for k, v in node.other.items() if k != "union-all" and v}
    if extra:
        lines.append(f"{indent}  options: {extra}")
    for c in node.children:
        render_physical(c, conns, indent + "   ", lines, show_conn)


def render_tables(tables: list, conns: dict, show_columns: bool, show_conn: bool, L: list[str]) -> None:
    groups = [("Fact tables", [t for t in tables if t.role == "fact"]),
              ("Dimension tables", [t for t in tables if t.role == "dimension"]),
              ("", [t for t in tables if not t.role])]
    w = max((len(display_name(t)) for t in tables), default=10) + 2
    for title, group in groups:
        if not group:
            continue
        if title:
            L.append(f"    {title} ({len(group)})")
        ind = "      " if title else "    "
        for t in group:
            name = display_name(t)
            if simple_table(t.physical):
                p = t.physical
                alias = p.name and strip_brackets(p.table.split(".")[-1]) != p.name
                L.append(f"{ind}{bold(name.ljust(w))}{unqualify(p.table)}" + (dim(f"  (alias {p.name})") if alias else ""))
            else:
                L.append(f"{ind}{bold(name)}")
                if t.physical:
                    render_physical(t.physical, conns, ind + "   ", L, show_conn)
            if show_columns and t.columns:
                cw = max(len(c.name) for c in t.columns)
                for c in t.columns:
                    src = dim(f"  ← {c.parent}.{c.remote_name}") if c.remote_name and c.remote_name != c.name else ""
                    L.append(f"{ind}   · {c.name:<{cw}}  {c.datatype:<9}{src}")


def render_relationships(rels: list, L: list[str], names: Optional[dict] = None) -> None:
    names = names or {}
    if not rels:
        L.append("    (none)")
        return
    rows = []
    for r in rels:
        f, s_ = r.first, r.second
        on = unqualify(r.predicate_resolved)
        card = f"{f.cardinality} : {s_.cardinality}"
        ri = (f"{'all' if f.referential_integrity.startswith('All') else 'some'} / "
              f"{'all' if s_.referential_integrity.startswith('All') else 'some'}")
        notes = [f"{ep.table.strip()} unique key from database" for ep in (f, s_) if ep.unique_key_source == "database"]
        for ep in (f, s_):
            unknown = {k: v for k, v in ep.raw.items()
                       if k not in ("object-id", "unique-key", "is-db-set-unique-key", "guaranteed-value")}
            if unknown:
                notes.append(f"{ep.table.strip()}: {unknown}")
        rows.append((names.get(f.table_id, f.table.strip()), names.get(s_.table_id, s_.table.strip()),
                     on, card, ri, "; ".join(notes)))

    w_to = max([len(r[1]) for r in rows] + [len("to table")]) + 2
    w_on = max([len(r[2]) for r in rows] + [len("joined on")]) + 2
    w_card = 13
    L.append(dim(f"      {'  to table':<{w_to + 2}}{'joined on':<{w_on}}{'cardinality':<{w_card}}"
                 f"records match (from / to)"))
    by_from: dict[str, list] = {}
    for r in rows:
        by_from.setdefault(r[0], []).append(r)
    for frm, group in by_from.items():
        L.append(f"    {bold(frm)}")
        for _, to, on, card, ri, notes in sorted(group, key=lambda x: x[1].lower()):
            L.append(f"      → {to:<{w_to}}{on:<{w_on}}{card:<{w_card}}{ri}" + (dim(f"   {notes}") if notes else ""))


def render_text(ds: DataSource, show_columns: bool) -> str:
    L: list[str] = []
    L += heavy_rule(f"DATA SOURCE   {ds.caption}")
    if ds.server_info:
        si = ds.server_info
        L.append(f"  Server       {si['server']}   site: {si['site'] or '(default)'}   project: {si['project']}")
        L.append(f"  ID           {si['luid']}")
        L.append(f"  Status       {'extract' if si['has_extracts'] else 'live'}   certified: "
                 f"{'yes' if si['certified'] else 'no'}   last updated: {si['updated_at']}")
    L.append(f"  Model        {ds.model or 'unknown'}")
    L.append(f"  Summary      {len(ds.connections)} connection(s), {len(ds.tables)} table(s), "
             f"{len(ds.relationships)} relationship(s), {ds.calculated_fields} calculated field(s)")
    note = ds.other_settings.get("note")
    if note:
        L.append(f"  NOTE         {note}")

    conns = ds.other_settings.get("_conn_captions", {})
    conn_names = [c.name for c in ds.connections]
    names = {t.id: display_name(t) for t in ds.tables}

    # assign each logical table to the connection(s) its physical tables come from
    table_conns = {}
    for t in ds.tables:
        tc = [c for c in leaf_connections(t.physical) if c in conn_names]
        table_conns[t.id] = tc or conn_names[:1]
    multi_conn_tables = [t for t in ds.tables if len(table_conns[t.id]) > 1]

    for i, c in enumerate(ds.connections, 1):
        label = c.caption or c.name
        L += section(f"CONNECTION {i} of {len(ds.connections)}   {label}   ({c.cls})")
        if c.server:
            L.append(f"  Server       {c.server}" + (f":{c.port}" if c.port else ""))
        if c.dbname:
            L.append(f"  Database     {c.dbname}" + (f"   schema: {c.schema}" if c.schema else ""))
        if c.username or c.authentication:
            L.append(f"  Login        {c.username or '-'}" + (f"   ({c.authentication})" if c.authentication else ""))
        if c.initial_sql:
            sql = c.initial_sql.splitlines()
            L.append(f"  Initial SQL  {sql[0]}")
            L += [f"               {l}" for l in sql[1:]]
        if c.query_band:
            L.append(f"  Query band   {c.query_band}")
        if c.customizations:
            L.append(f"  Customizations ({len(c.customizations)}):")
            L += [f"               {k} = {v}" for k, v in c.customizations.items()]

        tables = [t for t in ds.tables if table_conns[t.id] == [c.name]]
        ids = {t.id for t in tables}
        rels = [r for r in ds.relationships if r.first.table_id in ids and r.second.table_id in ids]
        L.append("")
        L.append(bold(f"  TABLES ({len(tables)})"))
        if tables:
            render_tables(tables, conns, show_columns, False, L)
        else:
            L.append("    (none)")
        L.append("")
        L.append(bold(f"  RELATIONSHIPS ({len(rels)})"))
        render_relationships(rels, L, names)

    if multi_conn_tables:
        L += section(f"TABLES SPANNING MULTIPLE CONNECTIONS ({len(multi_conn_tables)})")
        render_tables(multi_conn_tables, conns, show_columns, True, L)

    single = {t.id for t in ds.tables if len(table_conns[t.id]) == 1}
    cross = [r for r in ds.relationships
             if not (r.first.table_id in single and r.second.table_id in single
                     and table_conns[r.first.table_id] == table_conns[r.second.table_id])]
    if cross:
        L += section(f"CROSS-CONNECTION RELATIONSHIPS ({len(cross)})")
        render_relationships(cross, L, names)

    if ds.extract:
        e = ds.extract
        L += section("EXTRACT")
        L.append(f"  Enabled      {e.get('enabled')}")
        L.append(f"  Storage      {e.get('storage', '?')}")
        ec = e.get("connection", {})
        if ec:
            L.append(f"  File         {ec.get('dbname', '')}")
            L.append(f"  Last update  {ec.get('update-time', '-')}")
        extra = {k: v for k, v in e.get("attributes", {}).items() if k != "enabled" and v}
        if extra:
            L.append(f"  Settings     " + ", ".join(f"{k}={v}" for k, v in extra.items()))
        if e.get("refresh"):
            L.append(f"  Refresh      " + ", ".join(f"{k}={v}" for k, v in e["refresh"].items()))
        if e.get("last_refresh_event"):
            L.append(f"  Last refresh ({e['refresh_events']} events): {e['last_refresh_event']}")
        if e.get("filters"):
            L.append(f"  Filters      {', '.join(e['filters'])}")
        if e.get("tables"):
            L.append(f"  Tables ({len(e['tables'])}):")
            L += [f"    - {unqualify(t)}" for t in e["tables"]]

    if ds.filters:
        L += section(f"DATA SOURCE FILTERS ({len(ds.filters)})")
        L += [f"  - {f['column']}  ({f['class']})" for f in ds.filters]

    others = {k: v for k, v in ds.other_settings.items() if not k.startswith("_") and k != "note"}
    if others:
        L += section("OTHER SETTINGS")
        L += [f"  {k} = {v}" for k, v in others.items()]
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Diagram (Tableau-style logical layer canvas) -> SVG / PNG
# ---------------------------------------------------------------------------

BOX_W, BOX_H = 200, 28
ROW_H = 40
COL_GAP = 40
MARGIN = 20
ROOT_RAIL = 20  # space for the vertical line joining multiple base tables
FONT = "'Benton Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif"


def text_width(s: str, size: float = 12) -> float:
    """Rough text width estimate for Helvetica-like fonts."""
    w = 0.0
    for ch in s:
        if ch in "il.,:;|!'I ":
            w += 0.30
        elif ch in "mwMW":
            w += 0.85
        elif ch.isupper() or ch.isdigit() or ch in "_#%&":
            w += 0.66
        else:
            w += 0.54
    return w * size


def esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def table_aliases(node: Optional[PhysicalNode]) -> dict[str, str]:
    """{alias: full database table name} for all physical tables under a node."""
    if node is None:
        return {}
    out = {}
    if node.kind == "table" and node.name:
        out[node.name] = strip_brackets(node.table.split("].[")[-1].rstrip("]").lstrip("["))
    for c in node.children:
        out.update(table_aliases(c))
    return out


def display_name(t: LogicalTable) -> str:
    """Logical table name, or the full database table name when Tableau auto-shortened it
    (Tableau cuts generated table names off at 30 characters)."""
    cap = t.caption.strip()
    full = table_aliases(t.physical).get(cap, "")
    if len(cap) >= 25 and full != cap and full.startswith(cap):
        return full
    return cap


def diagram_layout(ds: DataSource):
    """Tree layout like Tableau: base table(s) left, related tables to the right.

    Multi-fact models with exactly two fact tables use a "bridge": fact A on the left,
    the (shared) dimensions in the middle, fact B on the right.

    Returns (positions {id: (col, row)}, tree_edges, cross_edges, rail_roots, n_rows)."""
    order = [t.id for t in ds.tables]
    seconds = {r.second.table_id for r in ds.relationships}
    facts = [t.id for t in ds.tables if t.role == "fact"]
    bridge = facts[1] if len(facts) == 2 else None
    roots = ([facts[0]] if bridge else facts) or [i for i in order if i not in seconds] or order[:1]

    adj: dict[str, list] = {i: [] for i in order}
    for r in ds.relationships:
        a, b = r.first.table_id, r.second.table_id
        if a in adj and b in adj:
            adj[a].append((b, r))
            adj[b].append((a, r))

    parent: dict[str, Optional[str]] = {}
    children: dict[str, list] = {i: [] for i in order}
    tree_rels: set[int] = set()
    depth: dict[str, int] = {}
    if bridge:
        parent[bridge] = None  # placed separately

    def bfs(start: list[str]) -> None:
        queue = []
        for rt in start:
            if rt not in parent or rt == bridge:
                parent[rt], depth[rt] = None, depth.get(rt, 0)
                queue.append(rt)
        while queue:
            n = queue.pop(0)
            for m, r in adj[n]:
                if m not in parent:
                    parent[m], depth[m] = n, depth[n] + 1
                    children[n].append(m)
                    tree_rels.add(id(r))
                    queue.append(m)

    bfs(roots)
    rows: dict[str, float] = {}
    counter = [0]

    def place(n: str) -> float:
        if not children[n]:
            rows[n] = counter[0]
            counter[0] += 1
        else:
            ys = [place(c) for c in children[n]]
            rows[n] = (ys[0] + ys[-1]) / 2
        return rows[n]

    for rt in roots:
        place(rt)

    if bridge:
        placed = [m for m, _ in adj[bridge] if m in rows]
        depth[bridge] = max((depth[m] for m in placed), default=0) + 1
        rows[bridge] = (min(rows[m] for m in placed) + max(rows[m] for m in placed)) / 2 if placed else counter[0]
        if not placed:
            counter[0] += 1
        for m, r in adj[bridge]:
            if m in rows:
                tree_rels.add(id(r))
        bfs([bridge])  # bridge's own (non-shared) tables, to its right
        for c in children[bridge]:
            place(c)

    while True:  # disconnected tables / islands
        rest = [i for i in order if i not in parent]
        if not rest:
            break
        roots.append(rest[0])
        bfs([rest[0]])
        place(rest[0])

    pos = {i: (depth[i], rows[i]) for i in order}
    tree_edges = [r for r in ds.relationships if id(r) in tree_rels]
    cross_edges = [r for r in ds.relationships if id(r) not in tree_rels]
    return pos, tree_edges, cross_edges, roots, counter[0]


def render_svg(ds: DataSource, edge_labels: bool = False, title: bool = True) -> str:
    pos, tree_edges, cross_edges, roots, n_rows = diagram_layout(ds)
    tables = {t.id: t for t in ds.tables}
    conns = ds.other_settings.get("_conn_captions", {})
    multi_root = len(roots) > 1
    facts = [t.id for t in ds.tables if t.role == "fact"]
    palette = ["#4e79a7", "#f28e2b", "#e15759", "#59a14f", "#b07aa1", "#76b7b2", "#edc948", "#9c755f"]
    fact_color = {f: palette[i % len(palette)] for i, f in enumerate(facts)} if len(facts) > 2 else {}

    def edge_label(r: Relationship) -> str:
        return f"{unqualify(r.predicate_resolved)}  ({r.first.cardinality[0]}:{r.second.cardinality[0]})"

    col_gap = COL_GAP
    if edge_labels and ds.relationships:
        col_gap = max(COL_GAP, int(max(text_width(edge_label(r), 10) for r in ds.relationships)) + 40)
    # each column is as wide as its longest table name (min. BOX_W), so names are never cut off
    box_w: dict[int, float] = {}
    for tid, (c, _) in pos.items():
        need = text_width(display_name(tables[tid])) + 24
        box_w[c] = max(box_w.get(c, BOX_W), need)
    col_x: dict[int, float] = {}
    top = MARGIN + (30 if title else 0)
    left = MARGIN + (ROOT_RAIL if multi_root else 0)
    n_cols = max((c for c, _ in pos.values()), default=0) + 1
    x = left
    for c in range(n_cols):
        col_x[c] = x
        x += box_w.get(c, BOX_W) + col_gap

    def bw(tid):
        return box_w[pos[tid][0]]

    def box_xy(tid):
        c, r = pos[tid]
        return col_x[c], top + r * ROW_H

    width = int(x - col_gap + MARGIN)
    height = top + max(n_rows, 1) * ROW_H - (ROW_H - BOX_H) + MARGIN

    S: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="{esc(FONT)}">',
        "<style>"
        ".edge{fill:none;stroke:#767676;stroke-width:2}"
        ".edge.cross{stroke-dasharray:5 4}"
        ".hit{fill:none;stroke:transparent;stroke-width:12}"
        "g.rel:hover .edge{stroke:#2c7bd6}"
        ".box{fill:#fff;stroke:#3b3b3b;stroke-width:1}"
        "g.tbl:hover .box{fill:#bdd9f2;stroke:#2c7bd6}"
        ".lbl{font-size:12px;fill:#333}"
        ".elbl{font-size:10px;fill:#777}"
        ".title{font-size:14px;fill:#555;font-weight:600}"
        "</style>",
        f'<rect width="100%" height="100%" fill="#fff"/>',
    ]
    if title:
        S.append(f'<text class="title" x="{MARGIN}" y="{MARGIN + 12}">{esc(ds.caption.strip())}</text>')

    # rail joining multiple base tables (as Tableau does for multi-fact models)
    rad = 8
    if multi_root:
        rx = MARGIN + ROOT_RAIL / 2
        ys = sorted(box_xy(r)[1] + BOX_H / 2 for r in roots)
        S.append(f'<path class="edge" d="M{rx},{ys[0]} V{ys[-1]}"/>')
        for y in ys:
            S.append(f'<path class="edge" d="M{rx},{y} H{left}"/>')

    def elbow(x1, y1, x2, y2, xm):
        if abs(y2 - y1) < 1:
            return f"M{x1},{y1} H{x2}"
        r = min(rad, abs(y2 - y1) / 2, (xm - x1), (x2 - xm))
        sgn = 1 if y2 > y1 else -1
        return (f"M{x1},{y1} H{xm - r} Q{xm},{y1} {xm},{y1 + sgn * r} "
                f"V{y2 - sgn * r} Q{xm},{y2} {xm + r},{y2} H{x2}")

    def rel_tip(r: Relationship) -> str:
        f, s_ = r.first, r.second
        return (f"{f.table.strip()} → {s_.table.strip()}\n"
                f"on: {readable(r.predicate_resolved)}\n"
                f"cardinality: {f.cardinality} : {s_.cardinality}\n"
                f"referential integrity: {f.table.strip()} = {f.referential_integrity}, "
                f"{s_.table.strip()} = {s_.referential_integrity}")

    edges = []
    for r, cross in [(r, False) for r in tree_edges] + [(r, True) for r in cross_edges]:
        a, b = r.first.table_id, r.second.table_id
        if a not in pos or b not in pos:
            continue
        if pos[a][0] > pos[b][0] or (cross and pos[a][0] == pos[b][0] and pos[a][1] > pos[b][1]):
            a, b = b, a
        edges.append((r, cross, a, b))
    # several lines ending in the same table (e.g. dimensions -> second fact): label at the line's start
    incoming: dict[str, int] = {}
    for _, _, _, b in edges:
        incoming[b] = incoming.get(b, 0) + 1

    for r, cross, a, b in edges:
        converge = incoming[b] > 1
        ax, ay = box_xy(a)
        bx, by = box_xy(b)
        y1, y2 = ay + BOX_H / 2, by + BOX_H / 2
        if bx > ax:
            x1, x2 = ax + bw(a), bx
            # with labels the bend sits away from the label's end, leaving the long segment for the label
            xm = (x2 - col_gap / 2 if not edge_labels else x2 - COL_GAP / 2 if converge else x1 + COL_GAP / 2)
            d = elbow(x1, y1, x2, y2, xm)
        else:  # same column: loop out to the right
            x1 = ax + bw(a)
            bulge = x1 + col_gap / 2
            d = f"M{x1},{y1} C{bulge},{y1} {bulge},{y2} {x1},{y2}"
            x2 = x1
        cls = "edge cross" if cross else "edge"
        color = fact_color.get(r.first.table_id) or fact_color.get(r.second.table_id)
        style = f' style="stroke:{color}"' if color else ""
        S.append(f'<g class="rel"><title>{esc(rel_tip(r))}</title>'
                 f'<path class="{cls}" d="{d}"{style}/><path class="hit" d="{d}"/>')
        if edge_labels and bx > ax:
            S.append(f'<text class="elbl" x="{x1 + 6}" y="{y1 - 5}">{esc(edge_label(r))}</text>' if converge else
                     f'<text class="elbl" x="{x2 - 6}" y="{y2 - 5}" text-anchor="end">{esc(edge_label(r))}</text>')
        S.append("</g>")

    for tid, t in tables.items():
        x, y = box_xy(tid)
        phys = sorted(physical_table_names(t.physical)) if t.physical else []
        tip = [t.caption.strip()]
        if t.role:
            tip.append(f"role: {t.role}")
        if simple_table(t.physical):
            tip.append(f"table: {unqualify(t.physical.table)}")
        elif t.physical:
            tip.append(f"physical tables: {', '.join(phys)}")
        cn = [conns.get(c, c) for c in leaf_connections(t.physical)]
        if cn:
            tip.append(f"connection: {', '.join(cn)}")
        if t.columns:
            tip.append(f"columns: {len(t.columns)}")
        label = display_name(t)
        S.append(f'<g class="tbl"><title>{esc(chr(10).join(tip))}</title>'
                 f'<rect class="box" x="{x}" y="{y}" width="{bw(tid)}" height="{BOX_H}" rx="1"/>'
                 f'<text class="lbl" x="{x + 10}" y="{y + BOX_H / 2 + 4}">{esc(label)}</text>'
                 + (f'<rect x="{x}" y="{y}" width="4" height="{BOX_H}" fill="{fact_color[tid]}"/>'
                    if tid in fact_color else "") + "</g>")

    S.append("</svg>")
    return "\n".join(S)


def write_image(svg: str, path: str) -> None:
    if path.lower().endswith(".svg"):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(svg)
        return
    if not path.lower().endswith(".png"):
        sys.exit("--image must end in .svg or .png")
    try:
        import cairosvg  # type: ignore
        cairosvg.svg2png(bytestring=svg.encode(), write_to=path, scale=2)
        return
    except ImportError:
        pass
    import shutil
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False, encoding="utf-8") as tmp:
        tmp.write(svg)
    try:
        if shutil.which("rsvg-convert"):
            subprocess.run(["rsvg-convert", "-z", "2", "-o", path, tmp.name], check=True)
        elif shutil.which("magick"):
            subprocess.run(["magick", "-density", "192", tmp.name, path], check=True)
        else:
            sys.exit("PNG output needs cairosvg (pip install cairosvg), rsvg-convert or ImageMagick; "
                     "or use an .svg filename")
    finally:
        os.unlink(tmp.name)


def mermaid_id(s: str) -> str:
    return re.sub(r"\W+", "_", s).strip("_") or "T"


def render_mermaid(ds: DataSource, show_columns: bool) -> str:
    L = ["erDiagram", f"    %% {ds.caption}"]
    ids = {}
    for t in ds.tables:
        ids[t.id] = mermaid_id(t.caption)
        if show_columns and t.columns:
            L.append(f'    {ids[t.id]}["{t.caption}"] {{')
            for c in t.columns:
                L.append(f"        {mermaid_id(c.datatype or 'unknown')} {mermaid_id(c.name)}")
            L.append("    }")
        else:
            L.append(f'    {ids[t.id]}["{t.caption}"]')
    for r in ds.relationships:
        left = "||" if r.first.cardinality == "One" else "}o"
        right = "||" if r.second.cardinality == "One" else "o{"
        label = r.predicate.replace('"', "'")
        L.append(f'    {ids.get(r.first.table_id, mermaid_id(r.first.table))} {left}--{right} '
                 f'{ids.get(r.second.table_id, mermaid_id(r.second.table))} : "{label}"')
    return "\n".join(L)


def to_jsonable(ds: DataSource) -> dict:
    d = asdict(ds)
    d["other_settings"] = {k: v for k, v in d["other_settings"].items() if not k.startswith("_")}
    return d


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_dotenv(path: str = ".env") -> None:
    """Load KEY=VALUE lines from .env (cwd, then script dir); real env vars take precedence."""
    for candidate in (path, os.path.join(os.path.dirname(os.path.abspath(__file__)), path)):
        if os.path.isfile(candidate):
            with open(candidate, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, val = line.split("=", 1)
                    key = key.strip().removeprefix("export ").strip()
                    val = val.strip()
                    if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                        val = val[1:-1]
                    os.environ.setdefault(key, val)
            return


def main() -> None:
    load_dotenv()
    p = argparse.ArgumentParser(description="Show tables, relationships and performance options of a Tableau data source.")
    p.add_argument("file", nargs="?", help="local .tds/.tdsx/.twb/.twbx file")
    srv = p.add_argument_group("Tableau Server / Cloud")
    srv.add_argument("--server", default=os.environ.get("TABLEAU_SERVER"),
                     help="server URL (default: env/.env TABLEAU_SERVER)")
    srv.add_argument("--site", default=os.environ.get("TABLEAU_SITE", ""),
                     help="site content URL (default: env/.env TABLEAU_SITE; empty = default site)")
    srv.add_argument("--datasource", "-d", help="published data source name or LUID")
    srv.add_argument("--project", help="project name, to disambiguate data sources with the same name")
    srv.add_argument("--list", action="store_true", help="list published data sources on the site")
    srv.add_argument("--token-name", help="PAT name (default: env TABLEAU_PAT_NAME; secret from TABLEAU_PAT_SECRET)")
    srv.add_argument("--username", help="sign in with username/password instead of a PAT")
    srv.add_argument("--insecure", action="store_true", help="skip TLS certificate verification")
    p.add_argument("--format", "-f", choices=["text", "json", "mermaid"], default="text")
    p.add_argument("--columns", "-c", action="store_true", help="include columns per table")
    p.add_argument("--image", "-i", metavar="PATH",
                   help="also draw the relationship diagram, Tableau style (.svg with hover tooltips, or .png)")
    p.add_argument("--edge-labels", action="store_true", help="in the image, label connectors with join fields")
    p.add_argument("--save-tds", metavar="PATH", help="also save the retrieved .tds XML (definition only)")
    args = p.parse_args()

    server_info: dict = {}
    if args.server and not args.file:
        if args.list:
            server_list(args)
            return
        if not args.datasource:
            p.error("--datasource is required with --server (or use --list)")
        raw, server_info = server_fetch(args)
        source_name = server_info["name"]
    elif args.file:
        with open(args.file, "rb") as fh:
            raw = fh.read()
        source_name = args.file
    else:
        p.error("give a file, or --server with --datasource / --list")

    xml_bytes = read_definition(raw, source_name)
    if args.save_tds:
        with open(args.save_tds, "wb") as fh:
            fh.write(xml_bytes)

    datasources = parse_xml(xml_bytes)
    for ds in datasources:
        ds.server_info = server_info

    if args.image:
        base, ext = os.path.splitext(args.image)
        for n, ds in enumerate(datasources, 1):
            path = args.image if len(datasources) == 1 else f"{base}_{n}{ext}"
            write_image(render_svg(ds, edge_labels=args.edge_labels), path)
            print(f"diagram written to {path}", file=sys.stderr)

    if args.format == "json":
        out = [to_jsonable(d) for d in datasources]
        print(json.dumps(out[0] if len(out) == 1 else out, indent=2))
    elif args.format == "mermaid":
        print("\n\n".join(render_mermaid(d, args.columns) for d in datasources))
    else:
        print("\n\n".join(render_text(d, args.columns) for d in datasources))


if __name__ == "__main__":
    main()
