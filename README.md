# TDS Lens

**See inside Tableau data sources.** Drop a `.tds`, `.tdsx`, `.twb` or `.twbx` file and see its connections, tables, relationships and performance options. The relationships are drawn the way Tableau's data source canvas draws them.

**→ [antichaos.github.io/tds-lens](https://antichaos.github.io/tds-lens/)**

Everything runs in your browser. The file is never uploaded, and the page makes no requests to other sites (enforced by its Content Security Policy).

### Offline version

Download **[tds-lens.html](https://antichaos.github.io/tds-lens/tds-lens.html)**: the whole app in one file (about 190 KB). Double-click it to open it in your browser. It needs no web server and no internet, so you can email it or put it on a network drive. Build it yourself with `npm run build` (output: `dist/tds-lens.html`).

## What it shows

- **Connections**: type, server, database and schema, login, Initial SQL, query banding, connection customizations
- **Tables per connection**: logical tables and the physical layer under each one (joins with their join conditions, unions, custom SQL). Full table names are shown even where Tableau cut them off at 30 characters
- **Relationships**: join fields, cardinality and referential integrity ("records match") for each side. Tableau's untouched defaults are flagged
- **Multi-fact models** (shared dimensions, Tableau 2024.2+): fact and dimension tables
- **Extract**: storage (single or multiple tables), refresh info, extract filters
- **Data source filters** and the number of calculated fields
- **Checks**: findings worth verifying (a name field joined to an ID field, join fields of different data types, a personal login) and notes worth documenting (default performance options, custom SQL, large physical join trees, Initial SQL, data source and extract filters). Each finding shows its evidence and can be highlighted in the diagram
- **Compare** two files, for example acceptance and production or two versions: connections, tables, columns, relationships, performance options, extract settings, filters and calculated fields. Tables and relationships are matched by name and schema names are ignored, so only real differences show. Drop two files at once, or use "Compare with another file"
- **Downloads**: Markdown documentation (for a wiki, Confluence or git), diagram as PNG or SVG, text report, Mermaid ER diagram, JSON

## Calc Lens: expensive calculations

**→ [antichaos.github.io/tds-lens/calcs.html](https://antichaos.github.io/tds-lens/calcs.html)** (offline: [calc-lens.html](https://antichaos.github.io/tds-lens/calc-lens.html))

A second page, built the same way (runs in your browser, nothing uploaded). Drop a `.twb` or `.twbx` to find the calculated fields that slow a workbook down:

- **String logic**: text parsed into dates (`DATEPARSE`, `DATE` on a string), long IF/CASE chains, many string comparisons, regular expressions, other string functions
- **LOD & table calculations**: FIXED/INCLUDE/EXCLUDE, nested LODs (also across calculations), table calculations, table calculations over table calculations
- **Dependencies**: calculation chains of 4+ levels, and calculations that build on expensive ones
- **Usage**: which sheets use each calculation (directly or through other calculations), which dashboards show them, which are used as filters or in data source filters, and which are not used at all. A table calculation used as a filter is flagged
- **Other**: data blending, `COUNTD`/`MEDIAN`/`PERCENTILE`, `NOW`/`TODAY`/`RANDOM`, user functions

Each calculation gets a severity from its findings and a **priority** that also weighs usage: one level higher when it is used in 3 or more sheets or in a filter, at most low when nothing uses it. Download the result as Markdown, CSV or JSON. A `.tds` works too, but without usage information.

## Getting a .tds from Tableau Server or Tableau Cloud

Open the published data source, choose **Download**, and pick the option without the extract. You only need the definition, so the download stays small.

## Command-line version

`tds_structure.py` does the same in a terminal. It can also read published data sources straight from Tableau Server or Tableau Cloud, again downloading only the definition, never the data.

```bash
pip install tableauserverclient          # only needed for server mode
python tds_structure.py MyData.tdsx                      # local file
python tds_structure.py MyData.tdsx -i model.png         # + diagram (needs rsvg-convert or cairosvg)

# Tableau Server / Cloud: put TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME,
# TABLEAU_PAT_SECRET in your environment or in a .env file
python tds_structure.py --list
python tds_structure.py -d "My data source" -f json
```

## Development

No build step for the website: `web/` is served as-is. `npm run build` only creates the single-file offline versions (`dist/tds-lens.html`, `dist/calc-lens.html`).

```bash
npm install        # dev dependencies for the tests only
npm test           # JS parser must match tds_structure.py --format json exactly
npm run serve      # http://localhost:8000
```

Put your own `.tds` files in `samples/private/` (gitignored). The tests also check them against the Python output.

Pushing to `main` runs the tests and deploys `web/` to GitHub Pages.

## Disclaimer

Not affiliated with or endorsed by Tableau or Salesforce. Tableau is a trademark of Salesforce, Inc. The sample file is synthetic.

## Licence

MIT. Bundles [JSZip](https://stuk.github.io/jszip/) (MIT).
