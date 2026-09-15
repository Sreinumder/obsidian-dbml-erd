# dbml-erd — local patch vs upstream 0.1.21

This is the `obsidian-dbml-erd` plugin (https://github.com/wrojasa/obsidian-dbml-erd),
cloned from tag `0.1.21` (commit `d292a41`), with a small local patch applied in
`src/main.ts` and a freshly built `main.js`.

## The previous version (upstream 0.1.21)

- Renders ```` ```dbml ```` code blocks as interactive ER diagrams (drag, tools,
  pan/zoom, background, settings through the Obsidian Settings tab and per-note
  front-matter).
- Parses DBML, including table `Note:'...'` and column `note: '...'`, storing them
  in `Table.note` / `Column.note`.
- Interaction: drag tables around (positions persisted in the note source),
  right-click on a table header or column row opens a small context menu
  (rename / retype / reorder / change ref / delete), cursor shows the *selected
  table name* only.
- **What it did NOT do:** the parsed `Table.note` and `Column.note` were never
  rendered anywhere — no hover tooltip, nothing in the context menu. Hovering a
  table showed only its name in the status bar.

## What the patch adds

Documentation on hover and click, so a note-making workflow (e.g. "what these
tables/columns do") becomes useful directly on the diagram:

1. **Table hover tooltip.** When a table has a `Note:`, `drawNodes` appends a
   native SVG `<title>` to the node group. Browsers/Electron show it as a tooltip
   whenever the pointer is over any element inside that table.
   (`src/main.ts`, `drawNodes`, around `Table` group creation)

2. **Column hover tooltip.** Each column row is now wrapped in its own `<g data-col>`.
   A column with a `note:` gets its own `<title>`: `"column — note"`. Because SVG
   tooltips use the *nearest* titled ancestor, the column tooltip wins over the
   table tooltip on column hover, and the table tooltip still shows everywhere else.
   (same `drawNodes`)

3. **Click context menu with the notes.** The existing right-click menus were
   extended:
   - `openHeaderMenu` prepends an `info` item with the table note when present.
   - `openColumnMenu` prepends an `info` item showing `"column — note"`.
   This makes the documentation reachable on mobile / tablets where hover does
   not exist. Long notes are truncated with `short(text, 200)` to fit one menu row.

## Files changed vs upstream

| File | Change |
|---|---|
| `src/main.ts` | `drawNodes` (table `<title>`, per-column `<g data-col>` + `<title>`), `openHeaderMenu` + `openColumnMenu` (info items), new `short()` helper |
| `main.js` | rebuilt via `npm run build` after the source edit |

No other files changed.

## Build & install

```bash
npm install
npm run build          # produces main.js
```

Install location (vault):

```
.obsidian/plugins/dbml-erd/main.js
```

Copy the built `main.js` there (the `manifest.json` / `styles.css` are unchanged
from 0.1.21) and restart Obsidian (Ctrl+R).

## Caveats

- Updating the plugin from the community store overwrites the patched `main.js`;
  the patch then needs to be rebuilt and re-copied.
- Notes are single-line strings (DBML `note:'...'` / `Note:'...'`). Avoid
  unescaped apostrophes inside them.
- The `dbml/` ER notes that consume this feature live in the ERP vault, not in
  this repo.