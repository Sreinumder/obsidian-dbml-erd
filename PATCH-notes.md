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
- **Focused tables are re-laid out compactly.** In focus mode the original
  positions/orientations are ignored: the focused tables are arranged in a tight
  horizontal row (gap 44px) as if the DBML contained only those tables. Edges are
  re-routed (manhattan) on the fly; the original layout is untouched — the
  persisted `@pos` lines only ever use the original coordinates, and leaving the
  focus mode restores the diagram exactly as it was.
- **Toolbar focus indicator.** The toolbar shows a label with the focused
  table(s) in angle brackets (`<Warehouses>`, or `<A + B>` for a pair) while
  focus is active; it disappears when not focused.
- **Fullscreen button.** A `⛶` button in the toolbar expands the diagram block
  to fill the whole window (element Fullscreen API). The SVG re-fits when
  entering and leaving fullscreen; the toolbar/labels stay visible inside it.
  Exit via the same button, Escape, or by closing the note (plugin exits
  fullscreen on unload).
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

### 4. Fixed: fullscreen/focus lost on interaction (state survives re-renders)

**The bug.** Three symptoms shared one root cause — Obsidian **re-renders the code
block** whenever the plugin writes layout data to the note (`vault.process()` in
`saveLayout`), destroying the current block and mounting a fresh one with no
memory of the runtime state:

- **Zooming** (`+`/`−`) scheduled a save → re-render → the old block's
  `onunload()` called `document.exitFullscreen()` → user kicked out of fullscreen.
- **Focus mode** (`focusTable`/pair) called `fit(true)` → save → re-render → the
  new block mounted with `focus = null` → focus visibly "reverted" moments later.
- **Right-clicking a table** opened Obsidian's native code-block context menu on
  top of the plugin's own menu; the extra overlay made Chromium exit fullscreen.

**The fix.**

- **State survives re-renders.** The plugin now keeps `focusState`
  (`sourcePath#lineStart` → focused table names) and `fullscreenBlock`
  (source path) and restores both on mount. Entering fullscreen through a
  helper (`enterFullscreen`) that only records the state if the request actually
  succeeds (self-healing if it's rejected during a re-render race).
- **No premature fullscreen exit.** `onunload` no longer calls
  `exitFullscreen()` (the browser exits naturally when the fullscreen element is
  removed; explicit exit was what broke re-render continuity).
- **No saves while focused.** `scheduleSaveLayout` is a no-op while focus mode
  is active — the compact arrangement and zoomed view are transient and must not
  be persisted (which is what triggered the self-inflicted re-render).
- **Auto-restore fullscreen.** A `fullscreenchange` observer re-enters
  fullscreen automatically if the plugin still expects this block to be
  fullscreen and the exit was *not* user-initiated (Escape or the `⛶` button
  mark `userExitFs`). Menu-driven and re-render exits bounce right back.
- **Native context menu suppressed.** Right-click inside the diagram no longer
  raises Obsidian's duplicate code-block menu on top of the plugin's own
  menus.

## Files changed vs upstream

| File | Change |
|---|---|
| `src/main.ts` | hover tooltips + menus (`drawNodes`, `openHeaderMenu/ColumnMenu`, `short`); focus mode + reference panel (`visibleTables`, `redrawNodes`, `focusTable`, `focusPair`, `fitAll`, `exitFocus`, `drawRefBadges`, `openRefPanel`, `closeRefPanel`, `updateFocusUI`, `fitToPx`); compact re-layout of focused tables (`layoutCompact`, `px()` accessor, focus-aware `redrawEdges`/`edgePts`/`fit`, drag writes to `layoutPos`, `@pos` persistence keeps original coords); toolbar `✕` + focus label + `⛶` fullscreen button (`toggleFullscreen`, `fullscreenchange` refit, exit on unload); Escape handler; empty-canvas click exits focus; toolbar/panel excluded from panning |
| `src/i18n.ts` | new keys: `refOutBadge`, `refInBadge`, `refHeadingOut/In`, `refHint`, `refNoRefs`, `focusOn`, `showAll`, `exitFocus`, `fullscreen`, `fullscreenExit` (en + es) |
| `styles.css` | toolbar → bottom-left; `.focus-exit` button; `.dbml-focus-label`; `.dbml-node-focus` outline; `.dbml-ref-badge*` pills; `.dbml-refpanel*` list; `:fullscreen` sizing |
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