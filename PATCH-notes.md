# dbml-erd — local patch vs upstream 0.1.21

This is the `obsidian-dbml-erd` plugin (https://github.com/wrojasa/obsidian-dbml-erd),
cloned from tag `0.1.21` (commit `d292a41`), with a local patch applied in
`src/main.ts`, `src/i18n.ts` and `styles.css`, plus a freshly built `main.js`.

This folder was cloned to `~/projects/obsidian/dbml-erd` so development can
continue on a proper git history. All new work happens on branch
`feat/focus-and-ref-ui`.

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
- Toolbar `+ / − / ⊡` pinned to the **top-right corner** — the same corner where
  Obsidian's native "Edit this block" button appears, so the small native button
  was hidden underneath the plugin toolbar.
- **What it did NOT do:** the parsed `Table.note` and `Column.note` were never
  rendered anywhere — no hover tooltip, nothing in the context menu. Hovering a
  table showed only its name in the status bar.

## What the patch adds

### 1. Documentation on hover and click

Notes written for a note-making workflow become useful directly on the diagram:

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

### 2. Focus mode + reference browsing (branch `feat/focus-and-ref-ui`)

- **Reference counters on headers.** Every table shows two small pill badges on
  its header: `→n` (outgoing references) and `←n` (incoming references). Clicking
  either badge opens a **reference list panel** near the cursor listing each
  linked table and the column pair that connects them.
  - **Left click on a list row** → focus on that single table (only it and the
    edges between its visible set are rendered, fitted to the view).
  - **Right click on a list row** → bring that table into the frame *together
    with the anchor table* (both fitted to the view). This is the "show me both
    tables" case.
- The header context menu gains **"Focus on this table"** and, while focused,
  **"Show all tables"**.
- **Exiting focus mode:** toolbar `✕` button (appears only while focused), the
  `⊡` fit-all button, right-click empty canvas, Escape, or the header menu item.
  While focused, the focused tables get an accent outline (`dbml-node-focus`).
- Draw/edge handling is focus-aware: only visible tables render, only edges whose
  *both* endpoints are visible render, and edge handles for hidden edges are
  suppressed. Pan/zoom and position persistence behave as before.
- **New i18n keys** for all labels/hints (English + Spanish).

### 3. Fixed: "Edit this block" button was hidden

Obsidian shows its native "Edit this block" button at the **top-right** of the
rendered block on hover. The plugin toolbar used to sit exactly there (`top:10px;
right:12px`) and covered it. Fixed by moving the plugin toolbar to the
**bottom-left** (`bottom:10px; left:12px`), so the native edit/copy controls
stay reachable and the whole feature is unhidden on very top right corner.

## Files changed vs upstream

| File | Change |
|---|---|
| `src/main.ts` | hover tooltips + menus (`drawNodes`, `openHeaderMenu/ColumnMenu`, `short`); focus mode + reference panel (fields, `visibleTables`, `redrawNodes`, `focusTable`, `focusPair`, `fitAll`, `exitFocus`, `drawRefBadges`, `openRefPanel`, `closeRefPanel`, `updateFocusUI`, `fitToPx`); toolbar `✕` button + ⊡→`fitAll`; Escape handler; focus-aware `redrawEdges`/`redrawHandles`/`fit`; empty-canvas click exits focus; toolbar/panel excluded from panning |
| `src/i18n.ts` | new keys: `refOutBadge`, `refInBadge`, `refHeadingOut/In`, `refHint`, `refNoRefs`, `focusOn`, `showAll`, `exitFocus` (en + es) |
| `styles.css` | toolbar → bottom-left; `.focus-exit` button; `.dbml-node-focus` outline; `.dbml-ref-badge*` pills; `.dbml-refpanel*` list |
| `main.js` | rebuilt via `npm run build` after the source edits |

Everything else remains as upstream 0.1.21 (`manifest.json`, `versions.json`).

## Build & install

```bash
npm install
npm run build          # produces main.js
```

Install location (vault):

```
.obsidian/plugins/dbml-erd/main.js
.obsidian/plugins/dbml-erd/styles.css
```

Copy the built `main.js` **and** `styles.css` (styles changed) to the vault and
restart Obsidian (Ctrl+R).

## Caveats

- Updating the plugin from the community store overwrites the patched `main.js`;
  the patch then needs to be rebuilt and re-copied.
- Notes are single-line strings (DBML `note:'...'` / `Note:'...'`). Avoid
  unescaped apostrophes inside them.
- Header names are truncated with an ellipsis when reference badges are present
  (the full name is available as a hover tooltip).
- The `dbml/` ER notes that consume this feature live in the ERP vault, not in
  this repo.