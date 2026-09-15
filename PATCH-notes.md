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

### 5. Full-window renderer with toggleable code panel (branch `feat/focus-and-ref-ui`)

- **`⤢` toolbar button** (only in the in-note block) opens the diagram in a
  **separate full-window overlay** — `ErdWindowModal`, an Obsidian `Modal` whose
  container fills the viewport *and* asks the browser for real fullscreen on open
  (graceful fallback to the overlay if fullscreen is rejected). It renders a
  **fresh full diagram** (not the current focus), so it's a clean "presentation"
  view of the whole schema.
- **Toggleable read-only code panel.** The overlay header has `Code`, `Copy DBML`
  and `Close` buttons. The right-hand panel shows the exact DBML source of the
  block (issues no edits) with a one-click copy to clipboard.
- **Reuses the ELK layout cache.** New plugin helper `layoutFor(source, model)`
  keys on the DBML with `@pos/@view/@size/@edge` lines stripped, so opening the
  window doesn't recompute a layout already computed for the block. The modal
  deep-copies the node positions before handing them to `Diagram`, so dragging in
  the overlay never mutates the shared cache.
- **`Diagram` gains `opts.window`.** When set (overlay mode) the in-block-only
  chrome is skipped: the `⛶` fullscreen button, the `fullscreenchange` observer,
  the fullscreen auto-restore, the `⤢` button (avoids recursion) and the global
  Escape handler (the `Modal` owns Escape). Focus/ref-badges/pan-zoom all still
  work inside the overlay.
- **New i18n keys:** `windowOpen`, `windowTitle`, `windowCode`, `windowCopy`,
  `windowCopied`, `windowCopyError`, `windowExit` (en + es).

### 6. Editable code panel, interaction redesign, remove in-block fullscreen (branch `feat/focus-and-ref-ui`)

- **Removed the in-block fullscreen implementation** (`⛶` button, `fullscreenchange`
  observer, `enterFullscreen`/`toggleFullscreen`, `fullscreenBlock` state). Fullscreen
  now lives exclusively in the full-window overlay.
- **Editable code panel.** The right-hand panel in the overlay is now a monospace
  `<textarea>` with live preview: edits re-render the diagram (debounced 400 ms).
  A **Save** button writes the changes back to the note, merging the clean DBML
  with the existing `@pos/@view/@size/@edge` annotation lines (they are hidden
  in the editor and re-injected on save). A stale-render guard prevents rapid
  typing from producing out-of-order diagram updates.
- **Resizable split** between diagram and code panel via a drag handle.
- **Interaction redesign on table nodes.** Old left-click menus (`openHeaderMenu`,
  `openColumnMenu` — rename, change type, set color, focus, show notes) have been
  removed entirely. Replaced by:
  - **Left-click / drag** → move the table (unchanged).
  - **Middle-click** → focus on this table only.
  - **Right-click** → jump to this table (and column, if the click was on a
    column row) in the code editor, scrolling the line into view and placing the
    cursor at the start of the definition.
- **Jump-to-code** uses `Diagram.opts.onJump`, which `ErdWindowModal` wires to
  `jumpTo(table, col)`. The method finds the `Table <name>` line (and optionally
  the column line within it) via regex, focuses the textarea, sets the selection,
  and scrolls the target line to ~⅓ of the editor height.
- **New i18n keys:** `windowSave`, `windowSaved`, `windowSaveError` (en + es).
  Removed keys: `fullscreen`, `fullscreenExit`.
- **Layout:** diagram fills all space on the left (`flex:1`), code panel on the
  right (`width: 42%`, drag-resizable, collapsible via the `Code` button).
- **ELK layout cache cap:** capped at 256 entries to avoid unbounded growth during
  sustained editing in the overlay window.

### 7. Layout system dropdown: hierarchical / radial / organic (branch `feat/focus-and-ref-ui`)

- **Swappable layout algorithms.** A **Layout `<select>`** in the overlay window
  header lets you switch live between four systems, persisted per block as a
  `// @layout <kind>` annotation line written on **Save**:
  - `layered-lr` — hierarchical left→right (the classic layout; **default**).
  - `layered-tb` — hierarchical top→bottom.
  - `radial` — **circular "spherical" ring** we compute ourselves (finite and
    deterministic). ELK's own `radial` algorithm throws
    `The given graph is not a tree!` on cyclic ERDs, so it can't be used.
  - `organic` — ELK `stress` (force-directed cluster-ball look; works on cyclic
    graphs).
- **Own orthogonal edge router for non-hierarchical layouts.** `LayoutResult`
  now carries `routes: "elk" | "manhattan"`. For `radial`/`organic` the edges are
  routed by the diagram's existing 90° router (was only enabled during focus
  mode); for `layered-*`, ELK shapes them as before.
- **`@pos` only applies to hierarchical layouts.** Manual saved positions override
  the auto-layout only when the block uses `layered-lr`/`layered-tb`; switching to
  `radial`/`organic` (or the per-block annotation) ignores them so the geometry
  stays clean.
- **Parsing/persisting.** `parser.ts` exports `LayoutKind`, the `LAYOUT_KINDS`
  list, `parseLayout(source)` and `layoutLine(kind)`. The layout-annotation line
  is stripped for the clean editor text, rebuilt as `@layout` on **Save** (always
  exactly one, matching the dropdown), and preserved by `buildLayoutContent`.
- **Cache keys now include the layout kind.** `plugin.layoutKeyOf(source, kind)`
  keys the layout cache on `kind + DBML-without-@pos/@view/@size/@edge/@layout`,
  so each kind is cached independently and re-renders after save reuse it (no
  async placeholder flicker). `layoutFor(source, model, kind)` takes the kind
  explicitly; the modal reuses the same cache, matching the block.
- **Settings default.** New "Default layout" dropdown in the Settings tab
  (`settings.layout`); blocks without a `// @layout` line use it.
- **New i18n keys:** `layout`, `layered-lr`, `layered-tb`, `radial`, `organic`,
  `settingsLayout`, `settingsLayoutDesc` (en + es).

### 8. Live-edit reveal + table navigator (branch `feat/focus-and-ref-ui`)

- **Live-edit reveal (not focus mode).** While typing in the code editor, the
  table whose `Table … { }` block contains the cursor is highlighted with a
  dashed outline (`.dbml-node-live`) **and zoomed to fill the draw area** —
  but *all other tables remain visible* (unlike explore/focus mode, which hides
  them). The reveal follows the caret (input/click/keyup) and is re-applied after
  each debounced live re-render; it never fires while explore mode is active.
- **"<Name>" navigator pill.** When not exploring, the toolbar label (bottom-left)
  shows the watched table (`<Warehouses>`, or `<pick table…>` before the first
  reveal) and is **clickable**: it opens an alphabetical `Menu` of all tables in
  the schema. Picking one highlights, zooms to, and watches that table.
- **`Diagram.revealTable(name)`** sets the watched table, re-renders the nodes
  (adding the live class), and centers the view on that one table
  (`fitToTable`) with the standard zoom cap; it exits an active explore mode
  first. `Diagram.exploring` getter (public) lets the window decide when revealing
  is allowed; `Diagram.refit()` re-frames the whole diagram (used when switching
  layout systems); `Diagram.hasTable(name)` guards lookups.
- **jump-to-code now reveals too.** Right-clicking a table/column in the diagram
  selects the code line **and** reveals that table on the left (normal mode only).
- **New i18n keys:** `navPick` (en + es).

## Files changed vs upstream

| File | Change |
|---|---|
| `src/main.ts` | focus mode + reference panel; compact re-layout of focused tables; toolbar `✕` + focus label; `ErdWindowModal` full-window overlay (editable code panel with live preview + save-back to note, drag-resizable split, stale-render guard, jump-to-code); `Diagram.openWindow()`, `opts.window` mode, `opts.onJump`, `Diagram.getView()`, plugin `layoutFor()` cache helper (capped at 256); removed in-block fullscreen (`⛶`/`fullscreenchange`/`enterFullscreen`); removed left-click menus + rename/type/color/delete helpers; middle-click → focus, right-click → jump to code; **layout dropdown + kind-aware cache key (`layoutKeyOf`), `// @layout` per-block line (parse/replace on save), Settings "Default layout"; radial (own circular ring) & organic (ELK stress) layouts with `routes: "manhattan"` self-routing; `Diagram.revealTable`/`fitToTable`/`exploring`/`refit`/`hasTable`, clickable `<Name>` table navigator pill, live-edit reveal (`dbml-node-live`)** |
| `src/parser.ts` | **`LayoutKind`/`LAYOUT_KINDS`/`parseLayout`/`layoutLine` for the `// @layout` annotation** |
| `src/layout.ts` | **`computeLayout(model, kind)`, `LayoutResult.routes`, custom `radialNodes` (circular ring) + `stressNodes` (organic), layered direction from kind** |
| `src/i18n.ts` | new keys: `refOutBadge`, `refInBadge`, `refHeadingOut/In`, `refHint`, `refNoRefs`, `focusOn`, `showAll`, `exitFocus`, `windowOpen`, `windowTitle`, `windowCode`, `windowSave`, `windowSaved`, `windowSaveError`, `windowCopy`, `windowCopied`, `windowCopyError`, `windowExit` (en + es); **+ `layout`, `layered-lr`, `layered-tb`, `radial`, `organic`, `settingsLayout`, `settingsLayoutDesc`, `navPick` (en + es)** |
| `styles.css` | toolbar → bottom-left; `.focus-exit` button; `.dbml-focus-label`; `.dbml-node-focus` outline; `.dbml-ref-badge*` pills; `.dbml-refpanel*` list; `.erd-window*` overlay, editor textarea, resizable split, hidden split; removed `:fullscreen` rules; **`.dbml-node-live`, `.dbml-nav` pill, `.erd-window-layout`/`-label`** |
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