# dbml-erd — local patch vs upstream 0.1.21

This is the `obsidian-dbml-erd` plugin (https://github.com/wrojasa/obsidian-dbml-erd),
cloned from tag `0.1.21` (commit `d292a41`), with a local patch applied in
`src/main.ts`, `src/parser.ts`, `src/layout.ts`, `src/i18n.ts` and `styles.css`,
plus a freshly built `main.js`.

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
- **Column underline in the renderer.** In addition to the table border, the
  exact column row (`.dbml-row-live`) being edited is underlined with a filled
  accent stroke. `markLiveRow(table, idx)` applies this directly to the DOM
  element (`.nodeLayer g[data-table] rect[data-col]`) without a full SVG redraw.
- **`<Name>` navigator replaced by ◀/▶ buttons + `<select>` dropdown.** The
  always-visible table navigator is now a proper toolbar control: `◀` (previous),
  an alphabetical `<select>` showing the current watched table, and `▶` (next).
  Selecting a table (or clicking ◀/▶) reveals it (highlight + fit-to-table with
  generous padding that leaves neighboring content visible). The navigator hides
  during explore mode.
- **◎ "Fit watched table" button.** Re-centers/zooms the watched table with the
  same generous padding, visible at all times.
- **Zoom percentage display.** A `<span class="dbml-zoom-pct">` in the toolbar
  shows `Math.round(k*100)%` — i.e. how large the text is relative to its
  natural size (100% = unzoomed). Updated on every pan/zoom/fit.
- **`fitToTable` padding.** The watched-table fit now uses `k = min((width*55%)/w, height*55%/h, 1.4)` so the table occupies ~55% of the view, leaving the
  surrounding area visible (edges/neighbors partially shown).
- **Rename + references prompt.** If the user renames a table in the editor
  (detected by signature match: exactly one table disappears and a new one with
  the same columns/types appears), `save()` shows a **ConfirmModal** asking
  whether to rewrite all `Ref` lines and `@pos`/`@edge` annotation lines that
  still reference the old name. On confirm the rewrite is applied before writing
  back to the note; the cancelled path leaves the file unchanged.
- **New i18n keys:** `navPrev`, `navNext`, `navFitWatched`, `renameTitle`,
  `renameBody`, `renameApply` (en + es).

### 9. Unified click model + reachable-table UI (branch `feat/focus-and-ref-ui`)

This iteration replaces the fourth button of almost every interaction with a
single consistent scheme and adds a redesigned table navigator.

- **One pointer scheme everywhere.** Left = move/pan, right = **watch** the
  table (reveal it, highlight + fit), middle = (de)focus the table. Applies to
  table headers, column rows, reference badges, edge arrows and dropdown rows.
  Edge-*editing* (handles/waypoints/cardinality) is removed entirely; arrows are
  now click/pan-only: left = pan, right = watch the *other* end, middle = focus
  both ends.
- **Focused tables are a set, not one.** Middle-clicking (or `✕`/`+` in the
  dropdown) adds/removes the table from the focus set; focusing a second table
  keeps the first. `focusPair(a, b)` is now additive. Empty focus set exits
  focus mode with a full fit.
- **Redesigned table dropdown (▾).** Replaces the `◀ <select> ▶` navigator and
  the in-toolbar focus label. Anchored above the toolbar: search field + a
  "Focused" section (only without an active query) + an "All tables" section.
  Clicking a row watches the table; `✕`/`+` toggles focus; middle-click on a
  row also toggles focus; the watched row is outlined. The dropdown updates live
  when it is open and closes on outside click or Escape.
- **Per-column reference badges.** In addition to the header `→n`/`←n` counters,
  every column row now shows its own `→n`/`←n` pill, right-aligned before the
  type (NN badge shift left accordingly). They reuse the header badge mechanics
  and are column-specific.
- **Single-ref badge = direct action.** If a badge has exactly one unique target,
  left/right click watches that table and middle-click focuses both (equivalent
  of clicking the referenced table itself). Hover tooltip lists which
  `table.column` of which table references it. Multiple targets open the
  reference picker panel (filtered to the column when the badge is a column).
- **Double-click jumps to the editor.** On a class name/column and requires the
  code editor (`onJump`); otherwise it just watches the table.
- **Layout lock (🔒) and no table editing by default.** The window header gains
  a lock toggle persisted as a `// @layoutLocked` / `// @layoutLocked false`
  block annotation. **The layout is now locked by default** (absence of the
  annotation means locked), so tables are packed and cannot be dragged; only a
  deliberate Unlock (persisted as `false`) allows moving tables, and while
  unlocked the drag tracks the cursor correctly (grab-point fix: `sx/sy` were
  never initialised, so the first pointermove warped the table to the bottom-
  right corner of the canvas).
- **Escaping focus mode is deliberate.** Clicking the background no longer exits
  focus mode — only Escape, or unfocusing every table via middle-click / the
  dropdown `✕` does.
- **Toolbar reordered + clickable zoom.** The readout now sits between the zoom
  buttons as `− 100% + ⊡ ◎ ▾`. Clicking the percentage opens a small preset
  menu (25…400%, plus the current level) that zooms keeping the canvas centre
  fixed; it closes on outside click or Escape.
- **Locked layout pans from tables.** With the layout locked (the default) a
  left-drag over a table now pans the canvas instead of doing nothing, and the
  cursor over tables shows the grab (pan) icon — `move` only when unlocked.
  The canvas toggles a `dbml-locked` class to pick the cursor.
- **Right-click also jumps the caret.** Right-clicking a table header/property
  still watches/reveals it in the GUI **and** moves the editor caret to that
  block (column included when a row was clicked), working from focus mode too.
- **Breadcrumb over the editor.** A `▸ tabla · columna` bar now VISIBLY sits
  above the DBML editor: the code panel is a flex column (crumb first in the
  DOM, editor flexes below), fed on *every* caret movement (click, arrows,
  `selectionchange` fired both on the document and the textarea), plus the live
  column underline — not only when editing. `.erd-window-crumb`.
- **Reveal robustness.** `fitToTable` retries once on the next animation frame
  when the canvas has no size yet, so the live caret reveal is not lost right
  after a re-render.
- **Polish.** The native modal `✕` (top-right) is removed — the "Close" button
  already exits. SVG text is `user-select: none`, so left-click dragging in the
  GUI never highlights text. Primary-key properties are just **bold + underlined**
  and foreign-key properties carry **no icon or emoji at all** — a reference is
  conveyed only by the in/out badges (and the arrow tooltips).
- **Last arrow used is highlighted.** Whenever you travel/watch via an edge
  (right-click an arrow, a reference badge, or a row of the reference list) the
  arrow you followed gets a `dbml-edge.live` accent until the next watch
  (`Diagram.watchEdge` + `watchedEdgeKey`, cleared by every `revealTable`).
- **Sensible jump-to-code selection.** A tiny per-line DBML parser
  (`parsePropLine`/`locPropLine`) now dissects class vs property vs type vs
  bracket content, so the selection is exact — **three patterns**, chosen by
  where you click in the GUI:
  - **Class name** — the word that follows `Table` (settings tolerated between
    the name and the brace: `Table Companies [headercolor: #607D8B] {`).
  - **Property name** — click on the property name row → only the first word
    (`  nombre`), found inside that table's `{ … }` block (search *below* the
    declared table, never crossing into a later table).
  - **Property type** — click on the type text (`.dbml-type`) in the GUI → only
    the type span `UUID`, `VARCHAR(255)`… (single or multi-word, up to the last
    non-space word before ` [` or end of line).
  - **Attrs/note** — parsed (bracket content extracted) for future use.
- **Zoom on watch = 100% centred, min-fit fallback.** Right-clicking a class
  now drops all margins/context: the class is placed exactly at the canvas
  centre with zoom 100%; only if it cannot fit at 100% does the zoom drop to the
  minimum that fits it completely.
- **Breadcrumb = live reverse pattern.** The crumb no longer relies on the old
  whole-block search (which failed on settings between `Table` and `{`): it
  parses the line under the cursor from left to right, the same three patterns —
  line starting with `Table` ⇒ the class name is the word after it; otherwise
  the first word is the property name; and when the caret sits on the property's
  TYPE the crumb shows `clase · propiedad · tipo`.
- **Removed radial & organic layouts.** `LAYOUT_KINDS` is now only
  `layered-lr`/`layered-tb`; `radialNodes`/`stressNodes` and their i18n keys are
  deleted.
- **New i18n keys:** `lockLayout`, `unlockLayout`, `searchTable`, `noResults`,
  `focusedTables`, `allTables`, `addToFocus`, `removeFromFocus`, `zoomPick`,
  `crumbIdle`; removed `radial`, `organic` (en + es).
- **Focus mode is now "sticky" fast-travel.** Watching NO LONGER quits focus
  mode: any "watch" trigger (right-click on a class, an arrow, a reference badge,
  a row of the reference list) while in focus mode ADDS the referenced class to
  the focus set (if not there) and watches it, then zooms to it — the mode stays.
  Middle-click on empty canvas space toggles focus mode on/off; the toolbar
  `◎ fit-watched` button is replaced by a `⊞` focus-mode toggle (highlighted while
  active), plus two buttons visible ONLY in focus mode: "Clear all" (drop every
  focused table) and "Exit focus" (back to the full diagram).
- **Focus survives reload = saved on the background.** The focus set is written
  to the note as a `// @focusOn TablaA,TablaB` annotation line inside the block
  (new parser `parseFocusOn`/`focusOnLine`; the window save-back and the inline
  layout saver both rewrite/remove it), so the focused state is restored across
  Obsidian restarts — not only across re-renders. The annotation is dropped when
  focus is cleared.

### 10. Static inline diagram + hierarchical focus layout (branch `feat/focus-and-ref-ui`)

- **The in-note diagram is now fully STATIC.** Editing dragging around the
  embedded block proved unstable, so everything interactive moved exclusively
  into the full-screen window. The embedded diagram has **no toolbar, no
  pan/zoom/panning, no drag, no dropdown, no context menu, no Escape handler**:
  a `pointerdown` anywhere on it opens the full-screen window
  (`openWindow`). A subtle `.dbml-static-hint` badge in the corner says so. The
  `interactive` flag (`opts.window`) gates every surface: toolbar creation,
  `bindPanZoom`/`bindResize`, node drag (`enableDrag`), edge handlers
  (`enableEdgeSelect`), the outside-click menu closers and Escape. The `⤢`
  window button is no longer needed — the whole block opens the window.
- **Watch never moves the view (no "zoom jumping").** `revealTable` no longer
  takes a `fit` argument and never re-centers/zooms: bringing or watching a new
  class while browsing keeps the current pan/zoom untouched. `fitToTable` (and
  its rAF retry) is deleted; all 10 call sites updated.
- **Focus has its own hierarchical layout, applied on every add/remove.**
  Besides the provisional compact row (`layoutCompact`), entering focus mode or
  adding/removing a focused table recomputes a **layered L→R** layout with ELK
  over *only the focused subset* (`reflowFocus`, async with a generation token
  `focusLayoutToken` so stale results are dropped), normalized to the canvas
  origin. Redraws in place without touching pan/zoom.
- **Ref-panel rows highlight already-focused targets.** Opening an in/out badge
  while in focus mode marks the rows whose destination table is already in the
  focus set with `.dbml-refpanel-row.focused` (accent outline + name colour).
- **Window diagram persists drags to the note again.** `openWindow` now passes
  the source `ctx`/`blockEl` through `ErdWindowModal` to the window `Diagram`
  (`opts.ctx`/`opts.el`), so moving tables in the unlocked window writes
  `@pos`/`@view` back into the real note (same path as the old embedded block).
- **New i18n reuse / CSS:** the static hint reuses `windowOpen`; CSS adds
  `.dbml-static` (pointer cursor over the whole canvas), `.dbml-static-hint` and
  `.dbml-refpanel-row.focused`.

### 11. Minimal-pan watch, dropdown hover peek + per-mode camera (branch `feat/focus-and-ref-ui`)

- **Fixed: dropdown list could not scroll.** The canvas `wheel` handler (zoom)
  `preventDefault()`s every wheel event, and the dropdown lives inside the
  canvas — so the wheel over the table list was swallowed and the list never
  scrolled. The zoom handler now returns early when the event target is inside
  `.dbml-dd`, `.dbml-refpanel` or `.dbml-zoom-menu` (their own overflow-shift).
  The panning `pointerdown` also exempts those same surfaces so clicking a list
  row never starts a canvas drag.
- **Watch = minimal pan, never zoom/or jump.** `revealTable` (dropdown click,
  badges, ref-panel rows, arrows, caret movement in the editor) now calls
  `ensureTableVisible(name)`: if the table is entirely inside the frame the
  camera does NOT move at all; if it sticks out, it computes the *minimum*
  per-axis translation (in world coords, current zoom kept) to bring the whole
  node in view and pans exactly that — as little on-screen change as possible.
  The pan leaves ~40 px of breathing room around the table when it has to move
  (no margin is added when the table is already fully visible). Tables
  wider/taller than the viewport fall back to centering that axis.
- **Double-click the zoom percentage jumps to 100%.** A `dblclick` on the
  `dbml-zoom-pct` readout calls `setZoomPct(100)` (keeps the canvas centre
  fixed) — separate from the single-click preset menu.
- **Zoom is bounded (25%–400%).** Interactive zoom (wheel, `+`/`−`,
  preset menu) is clamped to the same range as the preset menu; only the
  full-diagram `fit` may go below 25% (deliberate).
- **No infinite canvas dragging.** `applyView()` now runs `clampView()`: the
  amount of *empty* space beyond the diagram that panning can reveal is capped
  at ~30% of the viewport per axis (per-side), with a 40 px floor so the content
  can never fully leave the frame; diagrams wider than the viewport have no
  void and are panned freely.
- **Watch zoom floor of 75%.** If the current zoom is below 75%, watching a
  table jumps to 100% and centres it (`centerCameraOn`); at 75% or above the
  normal minimal-pan rule applies (keep your zoom).
- **Dropdown hover = temporary centred watch (peek).** `mouseenter` on a
  dropdown row centres the table (100% zoom, min-fit fallback — `centerCameraOn`,
  the old fit-to-table logic alone for this preview); the camera that was active
  before the first hover is saved once (`hoverCamera`) and restored when the
  pointer leaves the panel, the dropdown closes, or a row is clicked (a real
  click ends the peek and keeps the watch camera).
- **Camera kept per mode (normal ↔ focus).** Entering focus saves the current
  camera as `normalCamera` and restores the previous `focusCamera` (or fits the
  focused set the very first time); leaving focus saves `focusCamera` and
  restores `normalCamera`. The `⊞` toggle, `focusTable`, `focusPair` and
  `fitAll`/"Clear all" all round-trip through this, so "at what part and at what
  zoom" you were is remembered independently in each mode. Focus-camera changes
  are never persisted (saves stay paused during focus).
- **Focus set remembered across toggles.** Turning the mode off via `⊞`,
  middle-click on empty canvas, Escape or "Salir" records the current focused
  set (`lastFocusTables`); turning it back on restores exactly that set instead
  of restarting with the single watched/first table. "Quitar todas" clears the
  memory (passes `fitAll(false)`), as does unfocusing the last table one by one
  — those start fresh next time.

## Files changed vs upstream

| File | Change |
|---|---|
| `src/main.ts` | focus mode + reference panel; compact re-layout of focused tables; toolbar `✕` + focus label; `ErdWindowModal` full-window overlay (editable code panel with live preview + save-back to note, drag-resizable split, stale-render guard, jump-to-code); `Diagram.openWindow()`, `opts.window` mode, `opts.onJump`, `Diagram.getView()`, plugin `layoutFor()` cache helper (capped at 256); removed in-block fullscreen (`⛶`/`fullscreenchange`/`enterFullscreen`); removed left-click menus + rename/type/color/delete helpers; middle-click → focus, right-click → jump to code; **layout dropdown + kind-aware cache key (`layoutKeyOf`), `// @layout` per-block line (parse/replace on save), Settings "Default layout"; radial (own circular ring) & organic (ELK stress) layouts with `routes: "manhattan"` self-routing; `Diagram.revealTable`/`fitToTable`/`exploring`/`refit`/`hasTable`, ◀/▶ buttons + `<select>` table navigator, ◎ fit-watched button, zoom-% display (`dbml-zoom-pct`), live column underline (`markLiveRow`/`dbml-row-live`), rename + references prompt on save (`detectRename` + `ConfirmModal`)** |
| `src/parser.ts` | **`LayoutKind`/`LAYOUT_KINDS`/`parseLayout`/`layoutLine` for the `// @layout` annotation** |
| `src/layout.ts` | **`computeLayout(model, kind)`, `LayoutResult.routes`, custom `radialNodes` (circular ring) + `stressNodes` (organic), layered direction from kind** |
| `src/i18n.ts` | new keys: `refOutBadge`, `refInBadge`, `refHeadingOut/In`, `refHint`, `refNoRefs`, `focusOn`, `showAll`, `exitFocus`, `windowOpen`, `windowTitle`, `windowCode`, `windowSave`, `windowSaved`, `windowSaveError`, `windowCopy`, `windowCopied`, `windowCopyError`, `windowExit` (en + es); **+ `layout`, `layered-lr`, `layered-tb`, `radial`, `organic`, `settingsLayout`, `settingsLayoutDesc`, `navPrev`, `navNext`, `navFitWatched`, `renameTitle`, `renameBody`, `renameApply` (en + es)** |
| `styles.css` | toolbar → bottom-left; `.focus-exit` button; `.dbml-focus-label`; `.dbml-node-focus` outline; `.dbml-ref-badge*` pills; `.dbml-refpanel*` list; `.erd-window*` overlay, editor textarea (flex column so the breadcrumb bar is visible), resizable split, hidden split; removed `:fullscreen` rules; **`.dbml-node-live`, `.dbml-row-live`, `.dbml-zoom-pct`, `.dbml-nav-prev` (select + buttons), `.dbml-edge.live`, `.erd-window-crumb`, `.dbml-col.pk` underline, modal `✕` hidden, SVG `user-select: none`** |
| `main.js` | rebuilt via `npm run build` after the source edits |
| **`src/main.ts` (v9)** | unified pointer scheme (left=move/pan, right=watch, middle=focus); **dropdown (▾)** with search/`✕`/`+` (`openDropdown`/`refreshDropdown`/`addDdRow`/`toggleFocusTable`), replaces `◀/▶` + select + focus label; **multi-table focus set** (`focusPair` additive, `toggleFocusTable`); background click no longer exits focus mode (Escape/`✕` only); **per-column ref badges** in the column rows; **single-ref badge direct action + ref-panel fallback** (`handleBadgeClick`, `openRefPanel` with column filter, `elemCol`/`elemBadge`/`badgeRefs`/`badgeTables`/`badgeLabel`); `drawEdge` arrow tooltip (`title`) + click pan/right-watch/middle-focus both; **double-click → jump to editor** (`onJump`); **layout lock default ON** (`// @layoutLocked false` persists unlock; `setLayoutLocked`, lock button in `ErdWindowModal`, annotation regexes include it, `renderBlock` passes it); **locked layout pans from tables** (`letPan` in `enableDrag`, `dbml-locked` canvas class + grab cursor); **drag grab-point fix** (`sx/sy` in `enableDrag`); **right-click watch + caret jump**; **toolbar `− 100% +` + clickable zoom preset menu** (`toggleZoomMenu`/`setZoomPct`/`.dbml-zoom-menu`); **editor breadcrumb** (`updateCrumb`/`.erd-window-crumb` + `selectionchange` on doc & textarea); **last-arrow highlight** (`watchEdge`/`watchedEdgeKey`, `dbml-edge.live`); **3-pattern jump selection** (`parsePropLine`/`locPropLine` + `.dbml-type` click target): class name word / property name only / property type span, setting-aware `Table` line, block-scoped col search; **fitToTable = 100% centred, min-fit fallback** (no margins); **reverse-pattern breadcrumb** (`tableAtCaret` line parse: class / prop / prop·type, `CaretHit`); **PK bold+underline, no FK icon/emoji at all, removed native modal `✕`**; `fitToTable` rAF retry for live reveal; removed edge-editing methods (no-ops left); **focus = sticky**: watch adds to focus & stays in mode (`revealTable` no longer exits), middle-click on empty space toggles mode (`toggleFocusMode`), toolbar `⊞` toggle replaces `◎`, "Clear all"/"Exit focus" buttons shown only in focus, `// @focusOn` annotation persisted to the note (`saveFocusState`→`scheduleSaveFocus`→`saveFocusAnnot`/`buildFocusContent`, `getFocusedTables`) |
| **`src/parser.ts` (v9)** | `LAYOUT_KINDS` → only `layered-lr`/`layered-tb`; **`parseLayoutLocked`/`layoutLockLine` (absence = locked; explicit `false` value); `parseFocusOn`/`focusOnLine` (`// @focusOn`) for persisted focus** |
| **`src/layout.ts` (v9)** | removed `radialNodes`/`stressNodes` (only layered ELK path remains) |
| **`src/i18n.ts` (v9)** | **+ `lockLayout`, `unlockLayout`, `searchTable`, `noResults`, `focusedTables`, `allTables`, `addToFocus`, `removeFromFocus`, `zoomPick`, `toggleFocus`, `focusClearAll`** (en + es) |
| **`styles.css` (v9)** | **`.dbml-dd*` dropdown (sticky search, rows, sections, empty); `.dbml-zoom-pct` button + `.dbml-zoom-menu*`; `.erd-window-lock`; toolbar `button.on` active focus-toggle + `[data-wide]` text buttons** |
| **`main.js` (v9)** | rebuilt via `npm run build` after the source edits |
| **`src/main.ts` (v10)** | **`Diagram.interactive` (static in-note vs window); toolbar/menus/pan-zoom/drag/edge-select/Escape gated by it; static host = `.dbml-static` + `.dbml-static-hint` + any pointerdown → `openWindow()`; removed ⤢ button; `revealTable(name)` without fit, `fitToTable` deleted (10 callers updated); `reflowFocus()` (async, `focusLayoutToken`) — ELK layered-lr over the focused subset on enter/add/remove, normalized to origin; ref-panel rows get `.focused` when already in focus; `openWindow` passes `ctx`/`blockEl` to `ErdWindowModal` → window `Diagram` opts so drags persist `@pos/@view` in the note; focus restore in constructor gated to window mode** |
| **`styles.css` (v10)** | **`.dbml-static` (pointer cursor), `.dbml-static-hint`, `.dbml-refpanel-row.focused`; removed `.dbml-icon-link`** |
| **`src/main.ts` (v11)** | **dropdown wheel-scroll fixed (wheel/pointerdown ignore `.dbml-dd`/`.dbml-refpanel`/`.dbml-zoom-menu`); `ensureTableVisible()` minimal-pan watch (no zoom, no move when fully in frame); `centerCameraOn()` + `endHoverWatch()` + `hoverCamera` for dropdown hover peek; `normalCamera`/`focusCamera` retained per mode across `applyFocusView(entering)`/`fitAll` — focus toggles restore "where and at what zoom" per mode** |

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