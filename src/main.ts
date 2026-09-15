import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  Menu,
  Modal,
  App,
  Notice,
  TFile,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { t, setLang, Lang, LANGS } from "./i18n";
import {
  parseDBML,
  Model,
  Table,
  Ref,
  setRefOpInBlock,
  parsePositions,
  parseView,
  parseSize,
  parseEdges,
  LayoutKind,
  LAYOUT_KINDS,
  parseLayout,
  parseLayoutLocked,
  parseFocusOn,
  layoutLine,
  layoutLockLine,
  focusOnLine,
} from "./parser";
import {
  computeLayout,
  LayoutResult,
  NodePos,
  Pt,
  ROW_H,
  HEAD_H,
  NODE_W,
} from "./layout";

const NS = "http://www.w3.org/2000/svg";

interface DbmlErdSettings {
  lang: Lang;
  // sistema de layout por defecto (por bloque puede anularse con `// @layout`)
  layout: LayoutKind;
}
const DEFAULT_SETTINGS: DbmlErdSettings = { lang: "en", layout: "layered-lr" };

export default class DbmlErdPlugin extends Plugin {
  settings: DbmlErdSettings = { ...DEFAULT_SETTINGS };
  // arista seleccionada por bloque (sourcePath#lineStart); sobrevive a los
  // re-render del code block para no perder los handles al guardar el layout.
  selByBlock = new Map<string, string | undefined>();
  // estado de enfoque por bloque; sobrevive a re-renders (vault.process re-render)
  focusState = new Map<string, string[]>();
  // cache de layout ELK por estructura DBML (ignorando @pos/@view/@size/@edge):
  // así los re-render que dispara guardar el layout no recalculan ELK ni
  // muestran el placeholder async (esa pausa era el "parpadeo" visible).
  private layoutCache = new Map<string, LayoutResult>();
  // loadSettings corre sin await en onload (solo fija idioma de i18n);
  // renderBlock la espera para que hasta el placeholder salga en el idioma
  // correcto sin bloquear el arranque de Obsidian.
  private settingsReady?: Promise<void>;

  async onload() {
    const handler = (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext
    ) => this.renderBlock(source, el, ctx);
    this.registerMarkdownCodeBlockProcessor("dbml", handler);
    this.registerMarkdownCodeBlockProcessor("DBML", handler);
    this.addSettingTab(new DbmlErdSettingTab(this.app, this));
    // si data.json está corrupto, cae al idioma por defecto sin romper renders
    this.settingsReady = this.loadSettings().catch(() => {});
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    setLang(this.settings.lang);
  }

  async saveSettings() {
    setLang(this.settings.lang);
    await this.saveData(this.settings);
  }

  // layout ELK/custom con cache (misma clave que renderBlock): lo reutiliza el
  // modo "ventana" para no recalcular el layout al abrir el diagrama en un
  // overlay. `kind` = sistema de layout (el de la nota o el elegido en vivo).
  async layoutFor(
    source: string,
    model: Model,
    kind: LayoutKind
  ): Promise<LayoutResult> {
    const layoutKey = this.layoutKeyOf(source, kind);
    let layout = this.layoutCache.get(layoutKey);
    if (!layout) {
      layout = await computeLayout(model, kind);
      // evita que el cache crezca indefinidamente (uso intensivo al editar en
      // la ventana); al vaciar, el siguiente render del code block calcula de
      // nuevo con una pausa breve (placeholder) pero no crece la memoria.
      if (this.layoutCache.size > 256) this.layoutCache.clear();
      this.layoutCache.set(layoutKey, layout);
    }
    return layout;
  }

  // clave de cache: sistema de layout + DBML sin anotaciones de disposición
  // (pos/view/size/edge/layout no afectan a la geometría calculada).
  private layoutKeyOf(source: string, kind: LayoutKind): string {
    return (
      kind +
      "\n" +
      source
        .replace(/^[ \t]*\/\/[ \t]*@(pos|view|size|edge|layout|layoutLocked)\b.*$/gm, "")
        .trim()
    );
  }

  async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    if (this.settingsReady) await this.settingsReady;
    let model: Model;
    try {
      model = parseDBML(source);
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(
        t("parseError", {
          msg: e instanceof Error ? e.message : String(e),
        })
      );
      return;
    }
    if (model.tables.length === 0) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(t("noTables"));
      return;
    }
    try {
      const kind =
        parseLayout(source) ?? this.settings.layout ?? DEFAULT_SETTINGS.layout;
      // El layout depende solo de la estructura DBML y del sistema elegido, no
      // de las anotaciones de disposición; al ignorarlas en la clave, un
      // re-render por guardado reusa el layout cacheado y se renderiza sin
      // pausa async (sin parpadeo).
      const layoutKey = this.layoutKeyOf(source, kind);
      let layout = this.layoutCache.get(layoutKey);
      if (!layout) {
        // primer cálculo: muestra placeholder mientras ELK trabaja (async)
        el.empty();
        el.createDiv({ cls: "dbml-erd-wrap" }).setText(t("rendering"));
        layout = await computeLayout(model, kind);
        this.layoutCache.set(layoutKey, layout);
      }
      el.empty();
      const wrap = el.createDiv({ cls: "dbml-erd-wrap" });
      const hMatch = source.match(/\/\/\s*(?:canvas-)?height:\s*(\d+)/i);
      const height = hMatch ? parseInt(hMatch[1], 10) : undefined;
      const savedPos = parsePositions(source);
      const view = parseView(source);
      const size = parseSize(source);
      const savedEdges = parseEdges(source);
      // clona los nodos del layout cacheado: el Diagram (savedPos y el arrastre)
      // muta las posiciones, y la cache debe quedar prístina para otros render.
      const freshNodes: LayoutResult["nodes"] = {};
      for (const [k, v] of Object.entries(layout.nodes))
        freshNodes[k] = { ...v };
      const layoutForInstance: LayoutResult = {
        nodes: freshNodes,
        edges: layout.edges,
        routes: layout.routes,
      };
      ctx.addChild(
        new Diagram(wrap, model, layoutForInstance, {
          height,
          plugin: this,
          ctx,
          el,
          savedPos,
          view: view ?? undefined,
          size: size ?? undefined,
          savedEdges,
          layout: kind,
          layoutLocked: parseLayoutLocked(source),
          focus: parseFocusOn(source) ?? undefined,
        })
      );
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "dbml-erd-wrap" }).setText(
        t("layoutError", {
          msg: e instanceof Error ? e.message : String(e),
        })
      );
    }
  }
}

class Diagram extends MarkdownRenderChild {
  // límites del zoom interactivo (coinciden con el menú de presets 25–400%).
  // El encuadre del diagrama completo (fit) puede bajar de 25%: es voluntario.
  private static readonly MIN_ZOOM = 0.25;
  private static readonly MAX_ZOOM = 4;
  // fracción máxima del viewport que puede quedar VACÍA al arrastrar (el resto
  // de espacio "fuera del diagrama" en pantalla no debe pasar de ~30%).
  private static readonly MAX_EMPTY = 0.3;
  // suelo en px de tabla que debe seguir visible en cada eje si el diagrama es
  // tan pequeño que ni siquiera un 30% de vacío es suficiente para perderlo.
  private static readonly KEEP_VISIBLE = 40;
  private model: Model;
  private pos: Record<string, NodePos>;
  private elkEdges: Pt[][]; // ruta ELK original por ref
  private selKey?: string; // clave de persistencia de selección (sourcePath#linea)
  private customEdges: Record<string, Pt[]> = {}; // waypoints intermedios por ref
  // frame de anclas (extremos + lados) con el que se autorizaron los waypoints
  // de cada ref; sirve para estirarlos afín-mente al mover tablas (base->actual).
  private customEdgeBase: Record<
    string,
    { ax: number; ay: number; bx: number; by: number; aR: boolean; bR: boolean }
  > = {};
  private _selectedEdge?: string; // ref con handles visibles
  private get selectedEdge(): string | undefined {
    return this._selectedEdge;
  }
  private set selectedEdge(v: string | undefined) {
    this._selectedEdge = v;
    if (this.selKey && this.plugin) this.plugin.selByBlock.set(this.selKey, v);
  }
  private view = { x: 30, y: 30, k: 1 };
  private movedTables = new Set<string>();
  private saveTimer = 0;
  private hostEl?: HTMLElement;
  private lastSize = "";
  private plugin?: DbmlErdPlugin;
  private ctx?: MarkdownPostProcessorContext;
  private blockEl?: HTMLElement;
  private svg: SVGSVGElement;
  private vp: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private handleLayer: SVGGElement;
  // modo enfoque: solo se dibujan estas tablas (null = diagrama completo).
  private focus: Set<string> | null = null;
  // true solo dentro de la ventana/overlay a pantalla completa (ErdWindowModal):
  // el diagrama incrustado en la nota es ESTÁTICO — cualquier clic abre la
  // ventana y no hay pan/zoom/arrastre (sus interacciones resultaron inestables).
  private interactive: boolean;
  private refPanel?: HTMLElement;
  private refPanelCleanup?: () => void;
  // salto a la posición del código (overlay): click derecho en tabla/columna.
  private onJump?: (
    table: string,
    col: string | null,
    part: "class" | "name" | "type"
  ) => void;
  // en modo enfoque las tablas se re-dispersan en una fila compacta (se ignora
  // la posición/orientación original); este mapa se descarta al salir.
  private layoutPos: Record<
    string,
    { x: number; y: number; w?: number; h?: number }
  > | null = null;

  // sistema de layout activo y quién rutea las aristas: ELK ("elk", jerárquico)
  // o el router ortogonal propio ("manhattan").
  private layoutKind: LayoutKind;
  private routingMode: "elk" | "manhattan";
  // tabla "vigilada" del modo normal: se resalta (.dbml-node-live) y concentra
  // la vista sin ocultar el resto (a diferencia del modo enfoque/exploración).
  private watchedTable: string | null = null;
  // última arista usada para vigilar/emigrar una tabla (resaltada).
  private watchedEdgeKey: string | null = null;
  // porcentaje de zoom visible en la barra (k*100 ⇒ tamaño de letra relativo).
  private zoomPct?: HTMLElement;
  // columna subrayada en vivo sobre la tabla vigilada (índice de fila).
  private liveRow: { table: string; idx: number } | null = null;
  private liveRowEl?: SVGRectElement;
  // layout locked: impide el arrastre de tablas/aristas.
  private layoutLocked = true;
  // dropdown panel (buscador + tabla de tablas enfocadas/todas)
  private dropdownPanel?: HTMLElement;
  private dropdownBtn?: HTMLButtonElement;
  // toolbar de enfoque: ⊞ (alternar) + "Quitar todas"/"Salir" (solo en enfoque)
  private focusBtn?: HTMLButtonElement;
  private clearAllBtn?: HTMLButtonElement;
  private exitBtn?: HTMLButtonElement;
  // menú de zooms estándar (al hacer clic en el porcentaje de la barra)
  private zoomMenu?: HTMLElement;
  // cámara recordada por modo: al entrar en enfoque se guarda la del modo
  // normal y se restaura al salir; lo mismo para la del modo enfoque, de modo
  // que alternar el ⊞ conserva "dónde estabas y a qué zoom" en cada modo.
  private normalCamera: { x: number; y: number; k: number } | null = null;
  private focusCamera: { x: number; y: number; k: number } | null = null;
  // último conjunto de tablas enfocadas (recordado al salir del modo): al
  // volver a activar el modo enfoque (⊞ / clic medio en el vacío) se restaura
  // ese mismo conjunto en vez de empezar de cero con una sola tabla.
  private lastFocusTables: string[] | null = null;
  // "vigilancia temporal" al pasar el ratón por el dropdown: se guarda la cámara
  // previa al primer hover (hoverCamera) y se restaura al salir del panel.
  private hoverCamera: { x: number; y: number; k: number } | null = null;
  private hoveredTable: string | null = null;

  constructor(
    parent: HTMLElement,
    model: Model,
    layout: LayoutResult,
    opts?: {
      height?: number;
      plugin?: DbmlErdPlugin;
      ctx?: MarkdownPostProcessorContext;
      el?: HTMLElement;
      savedPos?: Record<string, { x: number; y: number }>;
      view?: { x: number; y: number; k: number };
      size?: { w: number; h: number };
      savedEdges?: Record<string, { x: number; y: number }[]>;
      // true = montado dentro de la ventana/overlay (ErdWindowModal): sin
      // botón ⤢ y sin handler de Escape del bloque (lo gestiona el Modal).
      window?: boolean;
      // click derecho en tabla/columna: salta a esa posición en el editor (doble clic).
      onJump?: (table: string, col: string | null, part: "class" | "name" | "type") => void;
      // sistema de layout (default plugins.settings.layout si no se pasa).
      layout?: LayoutKind;
      // layout locked: impide el arrastre de tablas/aristas.
      layoutLocked?: boolean;
      // tablas inicialmente enfocadas (anotación `// @focusOn` del archivo).
      focus?: string[];
    }
  ) {
    super(parent);
    this.model = model;
    this.pos = layout.nodes;
    this.elkEdges = layout.edges.map((e) => e.pts);
    this.layoutKind = opts?.layout ?? "layered-lr";
    this.routingMode = layout.routes;
    this.layoutLocked = opts?.layoutLocked ?? true;
    this.plugin = opts?.plugin;
    this.ctx = opts?.ctx;
    this.blockEl = opts?.el;
    this.onJump = opts?.onJump;
    this.interactive = !!opts?.window;
    // el foco solo aplica dentro de la ventana (el incrustado estático siempre
    // muestra el diagrama completo; la anotación vive en el archivo).
    if (opts?.focus?.length && this.interactive)
      this.focus = new Set(opts.focus);

    // aplica posiciones guardadas (override del layout ELK): solo tienen
    // sentido en los layouts jerárquicos; en radial/organic se descartan.
    if (opts?.savedPos && this.layoutKind.startsWith("layered")) {
      for (const [name, p] of Object.entries(opts.savedPos)) {
        if (this.pos[name]) {
          this.pos[name].x = p.x;
          this.pos[name].y = p.y;
          this.movedTables.add(name);
        }
      }
    }
    // rutas de aristas editadas a mano: solo se conservan las que aún
    // corresponden a una relación existente (descarta @edge huérfanos).
    if (opts?.savedEdges) {
      const valid = new Set(this.model.refs.map((r) => this.edgeKey(r)));
      for (const [k, pts] of Object.entries(opts.savedEdges)) {
        if (valid.has(k) && pts.length)
          this.customEdges[k] = pts.map((p) => ({ ...p }));
      }
    }
    if (opts?.view) this.view = { ...opts.view };

    // restaura la selección de arista de un render previo del mismo bloque
    // (los handles deben reaparecer aunque Obsidian re-renderice al guardar).
    // Solo en la ventana: el incrustado estático ignora el foco.
    if (this.interactive && this.ctx && this.blockEl) {
      const info = this.ctx.getSectionInfo(this.blockEl);
      this.selKey = `${this.ctx.sourcePath}#${info ? info.lineStart : 0}`;
      // restaura el modo enfoque sobreviviendo al re-render (vault.process).
      // Prioridad: la anotación `// @focusOn` del archivo; si no, el estado en
      // memoria del plugin (lo que quede de antes de persistir).
      const savedFocus = opts?.focus?.length
        ? opts.focus
        : this.plugin?.focusState.get(this.selKey);
      if (savedFocus && savedFocus.length) {
        this.focus = new Set(savedFocus);
        this.layoutPos = this.layoutCompact(this.focus);
      }
    }

    const host = parent.createDiv({ cls: "dbml-erd-canvas" });
    this.hostEl = host;
    // cursor de pan sobre las tablas cuando el layout está bloqueado
    host.classList.toggle("dbml-locked", this.layoutLocked);
    if (opts?.height)
      host.style.setProperty("--dbml-erd-height", opts.height + "px");
    // tamaño guardado (override del default CSS / --dbml-erd-height)
    if (opts?.size) {
      host.style.width = opts.size.w + "px";
      host.style.height = opts.size.h + "px";
      this.lastSize = `${opts.size.w} ${opts.size.h}`;
    }
    this.svg = activeDocument.createElementNS(NS, "svg");
    this.svg.classList.add("dbml-erd-svg");
    this.vp = activeDocument.createElementNS(NS, "g");
    this.edgeLayer = activeDocument.createElementNS(NS, "g");
    this.nodeLayer = activeDocument.createElementNS(NS, "g");
    this.handleLayer = activeDocument.createElementNS(NS, "g");
    this.vp.appendChild(this.edgeLayer);
    this.vp.appendChild(this.nodeLayer);
    this.vp.appendChild(this.handleLayer); // handles por encima de todo
    this.svg.appendChild(this.vp);
    host.appendChild(this.svg);

    if (this.interactive) {
      // toolbar (esquina inferior izquierda: la superior derecha corresponde al
      // botón nativo "Edit this block" de Obsidian, que debe quedar accesible).
      const bar = host.createDiv({ cls: "dbml-erd-toolbar" });
      this.btn(bar, "−", () => this.zoom(0.87));
      const zp = bar.createSpan({ cls: "dbml-zoom-pct", text: "100%" });
      this.zoomPct = zp;
      // clic en el porcentaje: menú desplegable con zooms estándar
      zp.title = t("zoomPick");
      this.registerDomEvent(zp, "click", (ev) => {
        ev.stopPropagation();
        this.toggleZoomMenu();
      });
      // doble clic: salto directo a 100% (manteniendo el centro del lienzo)
      this.registerDomEvent(zp, "dblclick", (ev) => {
        ev.stopPropagation();
        this.setZoomPct(100);
      });
      this.btn(bar, "+", () => this.zoom(1.15));
      this.btn(bar, "⊡", () => this.fitAll());
      // ⊞ alterna el modo enfoque (clic medio sobre el vacío también lo hace).
      const fBtn = bar.createEl("button", { text: "⊞" });
      fBtn.title = t("toggleFocus");
      this.focusBtn = fBtn;
      this.registerDomEvent(fBtn, "click", () => this.toggleFocusMode());
      // "Quitar todas" y "Salir": visibles solo en modo enfoque.
      const clearAllB = bar.createEl("button", { text: t("focusClearAll") });
      clearAllB.title = t("focusClearAll");
      clearAllB.dataset.wide = "1";
      this.clearAllBtn = clearAllB;
      this.registerDomEvent(clearAllB, "click", () => this.fitAll(false));
      clearAllB.style.display = "none";
      const exitB = bar.createEl("button", { text: t("exitFocus") });
      exitB.title = t("exitFocus");
      exitB.dataset.wide = "1";
      this.exitBtn = exitB;
      this.registerDomEvent(exitB, "click", () => this.exitFocus());
      exitB.style.display = "none";
      // dropdown de tablas (en lugar del navegador select): buscador + secciones
      // "Enfocadas" y "Todas". Reemplaza al select de la barra y a la etiqueta
      // de enfoque; siempre visible (en modo normal y en modo enfoque).
      const ddBtn = bar.createEl("button", { text: "▾" });
      ddBtn.title = t("searchTable");
      this.dropdownBtn = ddBtn;
      this.registerDomEvent(ddBtn, "click", (ev) => {
        ev.stopPropagation();
        this.toggleDropdown();
      });
      const panel = host.createDiv({ cls: "dbml-dd" });
      panel.style.display = "none";
      this.dropdownPanel = panel;
      // al salir el cursor del panel se deshace la "vigilancia temporal" del
      // hover (se vuelve a la cámara que había antes del primer hover).
      panel.addEventListener("mouseleave", () => this.endHoverWatch());
      this.updateFocusUI();
    } else {
      // incrustado en la nota = ESTÁTICO (sin toolbar/pan/zoom/arrastre): un
      // clic en cualquier punto abre la ventana a pantalla completa, donde vive
      // toda la interacción. Evita la inestabilidad de editar desde el bloque.
      host.classList.add("dbml-static");
      host.createDiv({ cls: "dbml-static-hint", text: t("windowOpen") });
      this.registerDomEvent(host, "pointerdown", (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        void this.openWindow();
      });
    }

    this.drawNodes();
    this.redrawEdges();
    this.applyView();
    // si no hay vista guardada, encuadrar tras montar (necesita medidas del host)
    if (!opts?.view) activeWindow.requestAnimationFrame(() => this.fit());
    if (this.interactive) {
      this.bindPanZoom(host);
      this.bindResize(host);
      // el plugin abre sus propios menús (tabla/columna/arista): el contextmenu
      // nativo de Obsidian (menú duplicado del code block) se descarta para no
      // abrir un segundo overlay que saca del modo pantalla completa en Electron.
      this.registerDomEvent(host, "contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
      });
      // cierre del dropdown/menú de zoom al hacer clic fuera (captura: aunque el
      // clic esté en el SVG/toolbar, se cierran antes de que esos handlers hagan
      // otra cosa).
      this.registerDomEvent(
        activeDocument,
        "pointerdown",
        (e: PointerEvent) => {
          const tgt = e.target as Element;
          if (this.zoomMenu && this.zoomMenu.style.display === "block") {
            if (!tgt.closest?.(".dbml-zoom-menu") && tgt !== this.zoomPct)
              this.closeZoomMenu();
          }
          if (this.dropdownPanel?.style.display !== "block") return;
          if (tgt.closest?.(".dbml-dd")) return;
          if (tgt === this.dropdownBtn) return;
          this.closeDropdown();
        },
        { capture: true }
      );
      // Esc: cierra el dropdown/panel de referencias o sale del modo enfoque
      // (la ventana gestiona su propia tecla Escape a través del Modal).
      this.registerDomEvent(activeWindow, "keydown", (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (this.zoomMenu && this.zoomMenu.style.display === "block") {
          this.closeZoomMenu();
          return;
        }
        if (this.dropdownPanel && this.dropdownPanel.style.display === "block") {
          this.closeDropdown();
          return;
        }
        if (this.refPanel) {
          this.closeRefPanel();
          return;
        }
        if (!this.focus) return;
        if (activeDocument.querySelector(".menu, .modal-container")) return;
        this.exitFocus();
      });
    }
  }

  onunload() {
    if (this.saveTimer) activeWindow.clearTimeout(this.saveTimer);
    if (this.focusSaveTimer) activeWindow.clearTimeout(this.focusSaveTimer);
    this.closeRefPanel();
  }

  private btn(bar: HTMLElement, label: string, cb: () => void) {
    const b = bar.createEl("button", { text: label });
    this.registerDomEvent(b, "click", cb);
  }

  // posición efectiva: en modo enfoque se usa el arreglo compacto (layoutPos),
  // que se ignora la posición/orientación original; fuera de él, this.pos.
  private px(name: string) {
    return this.layoutPos ? this.layoutPos[name] ?? this.pos[name] : this.pos[name];
  }

  // abre el diagrama en un overlay a pantalla completa (ErdWindowModal), con el
  // código DBML en un panel lateral EDITABLE. Lee el bloque desde el archivo.
  private async openWindow() {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!(file instanceof TFile)) return;
    const data = await this.plugin.app.vault.read(file);
    const lines = data.split("\n");
    // contenido del bloque (sin las vallas ```dbml)
    const src = lines.slice(info.lineStart + 1, info.lineEnd).join("\n");
    new ErdWindowModal(this.plugin.app, this.plugin, src, {
      file,
      lineStart: info.lineStart,
      ctx: this.ctx,
      blockEl: this.blockEl,
    }).open();
  }

  // fila compacta (tablas pegadas, ignorando su posición original) para las
  // tablas enfocadas, en el orden del modelo.
  private layoutCompact(
    names: Set<string>
  ): Record<string, { x: number; y: number; w: number; h: number }> {
    const gap = 44;
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    let x = 0;
    for (const t of this.model.tables) {
      if (!names.has(t.name)) continue;
      const w = NODE_W;
      out[t.name] = {
        x,
        y: 0,
        w,
        h: HEAD_H + t.cols.length * ROW_H,
      };
      x += w + gap;
    }
    return out;
  }

  // ---- geometría ----
  private colRowY(table: string, col: string): number {
    const t = this.model.tables.find((t) => t.name === table);
    if (!t) return HEAD_H / 2;
    const i = t.cols.findIndex((c) => c.name === col);
    const idx = i < 0 ? 0 : i;
    return HEAD_H + idx * ROW_H + ROW_H / 2;
  }

  private edgeKey(r: Ref): string {
    return `${r.from}.${r.fromCol}->${r.to}.${r.toCol}`;
  }

  // rectángulos de tabla (obstáculos) excluyendo las indicadas
  private tableRects(
    ignore: string[]
  ): { x: number; y: number; w: number; h: number }[] {
    const ig = new Set(ignore);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const t of this.model.tables) {
      if (ig.has(t.name)) continue;
      const p = this.px(t.name);
      if (!p) continue;
      out.push({
        x: p.x,
        y: p.y,
        w: p.w || NODE_W,
        h: p.h || HEAD_H + t.cols.length * ROW_H,
      });
    }
    return out;
  }

  // ¿el segmento (axis-aligned) cruza algún rectángulo (con padding)?
  private segHitsRects(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    rects: { x: number; y: number; w: number; h: number }[],
    pad = 12
  ): boolean {
    const lox = Math.min(x1, x2),
      hix = Math.max(x1, x2),
      loy = Math.min(y1, y2),
      hiy = Math.max(y1, y2);
    for (const r of rects) {
      if (
        hix < r.x - pad ||
        lox > r.x + r.w + pad ||
        hiy < r.y - pad ||
        loy > r.y + r.h + pad
      )
        continue;
      return true;
    }
    return false;
  }

  // ruteo manhattan (para drag): Z entre puertos de columna, eligiendo un canal
  // vertical que no atraviese otras tablas.
  private manhattan(r: Ref): { pts: Pt[]; aSide: string; bSide: string } | null {
    const A = this.px(r.from);
    const B = this.px(r.to);
    if (!A || !B) return null;
    const ay = A.y + this.colRowY(r.from, r.fromCol);
    const by = B.y + this.colRowY(r.to, r.toCol);
    const aCx = A.x + NODE_W / 2;
    const bCx = B.x + NODE_W / 2;
    // Si las tablas se solapan en X (apiladas), ambas salen por el mismo lado
    // y la línea rodea por fuera; si no, cada una mira hacia la otra.
    const overlapX = Math.abs(bCx - aCx) < NODE_W;
    const aRight = overlapX ? true : bCx >= aCx;
    const bRight = overlapX ? true : !aRight;
    const ax = aRight ? A.x + NODE_W : A.x;
    const bx = bRight ? B.x + NODE_W : B.x;
    const stub = 18;
    const ax2 = ax + (aRight ? stub : -stub);
    const bx2 = bx + (bRight ? stub : -stub);
    // canal vertical base (como antes); luego se busca uno libre de colisiones.
    const baseMid = overlapX ? Math.max(ax2, bx2) : (ax2 + bx2) / 2;
    const rects = this.tableRects([r.from, r.to]);
    // candidatos: base, stubs y bordes ±margen de cada tabla. Se prueba el más
    // cercano a baseMid que no cruce ninguna tabla en los 3 tramos.
    const margin = 22;
    const cands = [baseMid, ax2, bx2];
    for (const t of this.model.tables) {
      const p = this.px(t.name);
      if (!p) continue;
      cands.push(p.x - margin, p.x + (p.w || NODE_W) + margin);
    }
    cands.sort((u, v) => Math.abs(u - baseMid) - Math.abs(v - baseMid));
    let midX = baseMid;
    for (const c of cands) {
      if (
        !this.segHitsRects(ax2, ay, c, ay, rects) &&
        !this.segHitsRects(c, ay, c, by, rects) &&
        !this.segHitsRects(c, by, bx2, by, rects)
      ) {
        midX = c;
        break;
      }
    }
    return {
      pts: [
        { x: ax, y: ay },
        { x: ax2, y: ay },
        { x: midX, y: ay },
        { x: midX, y: by },
        { x: bx2, y: by },
        { x: bx, y: by },
      ],
      aSide: aRight ? "E" : "W",
      bSide: bRight ? "E" : "W",
    };
  }

  private roundedPath(pts: Pt[], rad = 8): string {
    if (pts.length === 0) return "";
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1],
        c = pts[i],
        n = pts[i + 1];
      const v1 = [Math.sign(c.x - p.x), Math.sign(c.y - p.y)];
      const v2 = [Math.sign(n.x - c.x), Math.sign(n.y - c.y)];
      if (v1[0] === v2[0] && v1[1] === v2[1]) {
        d += ` L ${c.x} ${c.y}`;
        continue;
      }
      const r = Math.min(
        rad,
        Math.hypot(c.x - p.x, c.y - p.y) / 2,
        Math.hypot(n.x - c.x, n.y - c.y) / 2
      );
      d += ` L ${c.x - v1[0] * r} ${c.y - v1[1] * r} Q ${c.x} ${c.y} ${
        c.x + v2[0] * r
      } ${c.y + v2[1] * r}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L ${last.x} ${last.y}`;
  }

  private endpointSide(pts: Pt[], which: "start" | "end"): string {
    // lado por dirección del primer/último segmento
    if (which === "start") {
      return pts[1].x >= pts[0].x ? "E" : "W";
    }
    const n = pts.length;
    return pts[n - 2].x <= pts[n - 1].x ? "W" : "E";
  }

  private marker(
    x: number,
    y: number,
    side: string,
    kind: "many" | "one",
    optional = false
  ) {
    const g = activeDocument.createElementNS(NS, "g");
    const dir = side === "E" ? 1 : -1;
    if (kind === "many") {
      // pata de gallo (crow's foot): el esquema no conoce el mínimo, sin marca extra
      g.appendChild(this.line(x + dir * 11, y - 6, x, y));
      g.appendChild(this.line(x + dir * 11, y, x, y));
      g.appendChild(this.line(x + dir * 11, y + 6, x, y));
    } else if (optional) {
      // "cero o uno": círculo (FK nullable)
      g.appendChild(this.circle(x + dir * 9, y, 4));
    } else {
      // "exactamente uno": barra (FK not null)
      g.appendChild(this.line(x + dir * 8, y - 6, x + dir * 8, y + 6));
    }
    return g;
  }
  private line(x1: number, y1: number, x2: number, y2: number) {
    const l = activeDocument.createElementNS(NS, "line");
    l.setAttribute("x1", "" + x1);
    l.setAttribute("y1", "" + y1);
    l.setAttribute("x2", "" + x2);
    l.setAttribute("y2", "" + y2);
    l.classList.add("dbml-marker");
    return l;
  }
  private circle(cx: number, cy: number, r: number) {
    const c = activeDocument.createElementNS(NS, "circle");
    c.setAttribute("cx", "" + cx);
    c.setAttribute("cy", "" + cy);
    c.setAttribute("r", "" + r);
    c.classList.add("dbml-marker");
    c.classList.add("dbml-marker-circle");
    return c;
  }

  // ---- dibujo de aristas ----
  // redibuja aristas: si cualquiera de sus extremos fue movido, usa manhattan
  // (posición actual); si no, conserva la ruta ELK original (esquiva).
  private redrawEdges() {
    while (this.edgeLayer.firstChild)
      this.edgeLayer.removeChild(this.edgeLayer.firstChild);
    // en modo enfoque solo se dibujan las aristas con ambos extremos visibles
    const vis = this.visibleTables();
    const visSet = new Set(vis.map((v) => v.name));
    this.model.refs.forEach((r, i) => {
      if (this.focus && (!visSet.has(r.from) || !visSet.has(r.to))) return;
      const pts = this.edgePts(r, i);
      if (pts && pts.length >= 2) this.drawEdge(r, pts, this.edgeKey(r));
    });
  }

  // ruta actual de una arista, por prioridad:
  // 1) waypoints manuales (reanclando extremos a los puertos actuales)
  // 2) manhattan (si algún extremo fue movido)
  // 3) ruta ELK original
  private edgePts(r: Ref, i: number): Pt[] | null {
    const custom = this.customEdges[this.edgeKey(r)];
    if (custom && custom.length) return this.routeWithWaypoints(r, custom);
    // en modo enfoque las tablas se re-dispersaron (layoutPos): la ruta ELK
    // original queda desposicionada, así que se re-rutea manhattan siempre.
    if (
      this.routingMode === "manhattan" ||
      this.layoutPos ||
      this.movedTables.has(r.from) ||
      this.movedTables.has(r.to)
    ) {
      const m = this.manhattan(r);
      return m ? m.pts : null;
    }
    const pts = this.elkEdges[i];
    return pts && pts.length >= 2 ? pts : null;
  }

  // anclas actuales de los extremos contra los puertos de columna. Si se pasa un
  // frame base, conserva sus lados (estable al mover); si no, los deduce de la
  // posición de los waypoints respecto al centro de cada tabla.
  private currentAnchors(
    r: Ref,
    mid: Pt[],
    base?: { aR: boolean; bR: boolean }
  ): { ax: number; ay: number; bx: number; by: number; aR: boolean; bR: boolean } | null {
    const A = this.px(r.from);
    const B = this.px(r.to);
    if (!A || !B) return null;
    const ay = A.y + this.colRowY(r.from, r.fromCol);
    const by = B.y + this.colRowY(r.to, r.toCol);
    let aR: boolean, bR: boolean;
    if (base) {
      aR = base.aR;
      bR = base.bR;
    } else if (mid.length) {
      aR = mid[0].x >= A.x + NODE_W / 2;
      bR = mid[mid.length - 1].x >= B.x + NODE_W / 2;
    } else {
      aR = B.x + NODE_W / 2 >= A.x + NODE_W / 2;
      bR = !aR;
    }
    const ax = aR ? A.x + NODE_W : A.x;
    const bx = bR ? B.x + NODE_W : B.x;
    return { ax, ay, bx, by, aR, bR };
  }

  // mapea un valor de un eje desde el span base [ba,bb] al actual [ca,cb]
  // (afín). Si el span base es ~0 (extremos alineados) preserva el offset.
  private lerpAxis(v: number, ba: number, bb: number, ca: number, cb: number) {
    const span = bb - ba;
    if (Math.abs(span) < 1e-6) return ca + (v - ba);
    return ca + ((v - ba) / span) * (cb - ca);
  }

  // waypoints intermedios de una ref transformados del frame base al actual,
  // de modo que se estiren al mover cualquiera de las dos tablas.
  private mappedInterior(r: Ref, key: string): Pt[] {
    const mid = this.customEdges[key];
    if (!mid || !mid.length) return [];
    const base = this.customEdgeBase[key];
    const cur = this.currentAnchors(r, mid, base);
    if (!base || !cur) return mid.map((p) => ({ ...p }));
    return mid.map((p) => ({
      x: this.lerpAxis(p.x, base.ax, base.bx, cur.ax, cur.bx),
      y: this.lerpAxis(p.y, base.ay, base.by, cur.ay, cur.by),
    }));
  }

  // arma la polilínea: extremos reanclados a los puertos actuales + waypoints
  // intermedios estirados afín-mente (base->actual). Captura el frame base la
  // primera vez (p.ej. @edge cargado), cuando aún coincide con la posición real.
  private routeWithWaypoints(r: Ref, mid: Pt[]): Pt[] {
    const A = this.px(r.from);
    const B = this.px(r.to);
    if (!A || !B) return mid.slice();
    const key = this.edgeKey(r);
    if (!this.customEdgeBase[key]) {
      const cap = this.currentAnchors(r, mid);
      if (cap) this.customEdgeBase[key] = cap;
    }
    const cur = this.currentAnchors(r, mid, this.customEdgeBase[key]);
    if (!cur) return mid.slice();
    const inner = this.mappedInterior(r, key);
    return [
      { x: cur.ax, y: cur.ay },
      ...inner,
      { x: cur.bx, y: cur.by },
    ];
  }

  // localiza la columna FK (lado muchos) y si es nullable -> el lado uno es opcional
  private fkOptional(r: Ref): boolean {
    let table: string, col: string;
    if (r.op === "<") {
      table = r.to;
      col = r.toCol; // en <, el lado muchos es 'to'
    } else {
      table = r.from;
      col = r.fromCol; // en >, -, el FK está en 'from'
    }
    const t = this.model.tables.find((t) => t.name === table);
    const c = t?.cols.find((c) => c.name === col);
    return c ? !c.nn : false; // FK nullable => opcional; si no se halla, mandatorio
  }

  // Convierte una polilínea libre en una ortogonal (solo tramos H/V) insertando
  // un codo entre cada par de puntos que difieran en ambos ejes. Estrategia
  // "horizontal primero": el codo va en (b.x, a.y), de modo que cada punto
  // intermedio que el usuario arrastró queda como esquina real de 90° (se entra
  // en vertical y se sale en horizontal). Los extremos no se tocan. Se eliminan
  // puntos colineales/duplicados para no romper el redondeo de esquinas.
  private orthogonalize(pts: Pt[]): Pt[] {
    if (pts.length < 2) return pts.slice();
    const out: Pt[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx > 1e-6 && dy > 1e-6) out.push({ x: b.x, y: a.y }); // codo
      out.push({ x: b.x, y: b.y });
    }
    // colapsa puntos repetidos o colineales consecutivos
    const clean: Pt[] = [];
    for (const p of out) {
      const n = clean.length;
      if (n && Math.abs(clean[n - 1].x - p.x) < 1e-6 && Math.abs(clean[n - 1].y - p.y) < 1e-6)
        continue; // duplicado
      if (n >= 2) {
        const a = clean[n - 2];
        const m = clean[n - 1];
        const col1 = Math.abs(a.x - m.x) < 1e-6 && Math.abs(m.x - p.x) < 1e-6;
        const col2 = Math.abs(a.y - m.y) < 1e-6 && Math.abs(m.y - p.y) < 1e-6;
        if (col1 || col2) clean[n - 1] = p; // colineal: reemplaza el del medio
        else clean.push(p);
      } else clean.push(p);
    }
    return clean;
  }

  private drawEdge(r: Ref, pts: Pt[], key: string) {
    // la línea se dibuja ortogonalizada (90°); los markers usan los puntos
    // lógicos para deducir el lado de salida/entrada de cada extremo.
    const d = this.roundedPath(this.orthogonalize(pts));
    const path = activeDocument.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.classList.add("dbml-edge");
    if (this.customEdges[key]) path.classList.add("custom");
    if (key === this.watchedEdgeKey) path.classList.add("live");
    this.edgeLayer.appendChild(path);
    // path "hit" invisible y ancho para tocar con el dedo; lleva el tooltip
    // (qué tabla y qué propiedad de la otra tabla referencia) y el ratón.
    const hit = activeDocument.createElementNS(NS, "path") as SVGElement;
    hit.setAttribute("d", d);
    hit.classList.add("dbml-edge-hit");
    if (key === this.watchedEdgeKey) hit.classList.add("live");
    const tt = activeDocument.createElementNS(NS, "title");
    tt.textContent = `${r.from}.${r.fromCol} → ${r.to}.${r.toCol}`;
    hit.appendChild(tt);
    this.edgeLayer.appendChild(hit);
    if (this.interactive) this.enableEdgeSelect(hit, r);
    const s = pts[0];
    const e = pts[pts.length - 1];
    const fromMany = r.op === ">" || r.op === "<>";
    const toMany = r.op === "<" || r.op === "<>";
    const opt = this.fkOptional(r);
    this.edgeLayer.appendChild(
      this.marker(s.x, s.y, this.endpointSide(pts, "start"), fromMany ? "many" : "one", opt)
    );
    this.edgeLayer.appendChild(
      this.marker(e.x, e.y, this.endpointSide(pts, "end"), toMany ? "many" : "one", opt)
    );
  }

  // ---- edición de aristas ----
  private refresh() {
    this.redrawNodes();
    this.redrawEdges();
    this.redrawHandles();
  }

  // clic en una arista (sin edición de ruta):
//  izdo  = no hace nada (el pan lo gestiona bindPanZoom)
//  dcho  = vigilar la "otra" tabla (la que no está vigilada)
//  medio = enfocar ambas tablas conectadas
  private enableEdgeSelect(hit: SVGElement, r: Ref) {
    let sx = 0,
      sy = 0,
      moved = false;
    hit.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button === 0) return; // clic izquierdo: pan normal
      ev.stopPropagation();
      ev.preventDefault();
      sx = ev.clientX;
      sy = ev.clientY;
      moved = false;
      try {
        hit.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
      };
      const up = (e: PointerEvent) => {
        hit.removeEventListener("pointermove", mv);
        hit.removeEventListener("pointerup", up);
        hit.removeEventListener("pointercancel", up);
        try {
          hit.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        if (moved || e.type === "pointercancel") return;
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 1) {
          // clic medio: enfocar la tabla (origen) + la referenciada (destino)
          this.focusPair(r.from, r.to);
        } else if (e.button === 2) {
          // clic derecho: vigilar la tabla que no está vigilada
          const other = this.watchedTable === r.from ? r.to : r.from;
          this.revealTable(other);
          this.watchEdge(this.edgeKey(r));
        }
      };
      hit.addEventListener("pointermove", mv);
      hit.addEventListener("pointerup", up);
      hit.addEventListener("pointercancel", up);
    });
  }

  private openEdgeMenu(r: Ref, key: string, evt: PointerEvent) {
    const menu = new Menu();
    if (this.customEdges[key]) {
      menu.addItem((i) =>
        i
          .setTitle(t("resetRoute"))
          .setIcon("rotate-ccw")
          .onClick(() => this.resetEdge(key))
      );
    }
    // tipo de relación (cardinalidad): cambia pata de gallo (muchos) / barra (uno)
    const ops: [string, string][] = [
      ["<", t("relOneToMany")],
      [">", t("relManyToOne")],
      ["-", t("relOneToOne")],
      ["<>", t("relManyToMany")],
    ];
    for (const [op, label] of ops) {
      menu.addItem((i) =>
        i
          .setTitle(label)
          .setChecked(r.op === op)
          .onClick(() => this.setRefOp(r, op))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(t("deselect"))
        .setIcon("x")
        .onClick(() => {
          this.selectedEdge = undefined;
          this.refresh();
        })
    );
    menu.showAtMouseEvent(evt);
  }

  private setRefOp(r: Ref, op: string) {
    if (r.op === op) return;
    this.editBlock(
      (l, s, e) => setRefOpInBlock(l, s, e, r, op),
      t("changeRelTypeFail")
    );
  }

  private resetEdge(key: string) {
    delete this.customEdges[key];
    delete this.customEdgeBase[key];
    this.refresh();
    this.scheduleSaveLayout();
  }

  // prepara los waypoints de una ref para editarlos a mano "en frame actual":
  // si no existían, los siembra de la ruta visible; si existían, colapsa la
  // transformación base->actual a coordenadas absolutas. En ambos casos deja el
  // frame base = actual (mapeo identidad), de modo que el arrastre y el imán
  // ortogonal trabajen en las mismas coordenadas que se ven en pantalla.
  private seedCustom(r: Ref, i: number, key: string): Pt[] {
    if (!this.customEdges[key]) {
      const full = this.edgePts(r, i) ?? [];
      this.customEdges[key] = full.slice(1, -1).map((p) => ({ ...p }));
    } else {
      this.customEdges[key] = this.mappedInterior(r, key);
    }
    const cap = this.currentAnchors(r, this.customEdges[key]);
    if (cap) this.customEdgeBase[key] = cap;
    return this.customEdges[key];
  }

  private redrawHandles() {
    while (this.handleLayer.firstChild)
      this.handleLayer.removeChild(this.handleLayer.firstChild);
    if (!this.selectedEdge) return;
    const i = this.model.refs.findIndex(
      (r) => this.edgeKey(r) === this.selectedEdge
    );
    if (i < 0) return;
    const r = this.model.refs[i];
    // en modo enfoque una arista con extremos ocultos no muestra handles
    if (this.focus && (!this.focus.has(r.from) || !this.focus.has(r.to)))
      return;
    const key = this.selectedEdge;
    const pts = this.edgePts(r, i);
    if (!pts || pts.length < 2) return;
    const rad = 6 / this.view.k;
    // handle de inserción en el medio de cada segmento (hueco)
    for (let s = 0; s < pts.length - 1; s++) {
      const mx = (pts[s].x + pts[s + 1].x) / 2;
      const my = (pts[s].y + pts[s + 1].y) / 2;
      const add = this.circle(mx, my, rad * 0.7) as SVGElement;
      add.classList.remove("dbml-marker", "dbml-marker-circle");
      add.classList.add("dbml-edge-handle", "add");
      this.handleLayer.appendChild(add);
      this.enableHandleDrag(add, r, i, key, s, true);
    }
    // handle por cada waypoint intermedio (relleno)
    for (let m = 1; m < pts.length - 1; m++) {
      const h = this.circle(pts[m].x, pts[m].y, rad) as SVGElement;
      h.classList.remove("dbml-marker", "dbml-marker-circle");
      h.classList.add("dbml-edge-handle");
      this.handleLayer.appendChild(h);
      this.enableHandleDrag(h, r, i, key, m - 1, false);
      const idx = m - 1;
      h.addEventListener("contextmenu", (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.openWaypointMenu(r, i, key, idx, ev);
      });
    }
  }

  // click derecho sobre un quiebre (waypoint): menú para eliminarlo.
  private openWaypointMenu(
    r: Ref,
    i: number,
    key: string,
    idx: number,
    evt: MouseEvent
  ) {
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle(t("deleteVertex"))
        .setIcon("trash-2")
        .onClick(() => this.deleteWaypoint(r, i, key, idx))
    );
    menu.showAtMouseEvent(evt);
  }

  // elimina el waypoint idx; mismo flujo que insertar (seedCustom -> mutar ->
  // guardar). Si no quedan quiebres, descarta la ruta custom (vuelve al auto).
  private deleteWaypoint(r: Ref, i: number, key: string, idx: number) {
    const mids = this.seedCustom(r, i, key);
    if (idx < 0 || idx >= mids.length) return;
    mids.splice(idx, 1);
    if (mids.length === 0) {
      delete this.customEdges[key];
      delete this.customEdgeBase[key];
    }
    this.scheduleSaveLayout();
    this.refresh();
  }

  // arrastra un waypoint; si isAdd, inserta uno nuevo en segIdx y lo arrastra.
  private enableHandleDrag(
    el: SVGElement,
    r: Ref,
    i: number,
    key: string,
    idx: number,
    isAdd: boolean
  ) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      wp = idx,
      started = false;
    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      sx = ev.clientX;
      sy = ev.clientY;
      started = false;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      const mv = (e: PointerEvent) => {
        if (!started) {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 3) return;
          started = true;
          const mids = this.seedCustom(r, i, key);
          if (isAdd) {
            // punto inicial = posición actual del add-handle (medio del segmento)
            const cx = parseFloat(el.getAttribute("cx") || "0");
            const cy = parseFloat(el.getAttribute("cy") || "0");
            mids.splice(idx, 0, { x: cx, y: cy });
            wp = idx;
          } else {
            wp = idx;
          }
          ox = mids[wp].x;
          oy = mids[wp].y;
        }
        const mids = this.customEdges[key];
        if (!mids) return;
        // el punto se mueve libre; la ruta se ortogonaliza al dibujar (drawEdge),
        // así siempre queda en ángulos de 90° sin tocar los extremos.
        mids[wp] = {
          x: ox + (e.clientX - sx) / this.view.k,
          y: oy + (e.clientY - sy) / this.view.k,
        };
        el.setAttribute("cx", String(mids[wp].x));
        el.setAttribute("cy", String(mids[wp].y));
        this.redrawEdges(); // solo líneas; handles se reconstruyen al soltar
      };
      const up = (e: PointerEvent) => {
        el.removeEventListener("pointermove", mv);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        // tap sin arrastre sobre un add-handle: inserta un quiebre en ese punto
        // (antes solo se creaba al arrastrar, por eso "el click no hacía nada").
        if (!started && isAdd && e.type !== "pointercancel") {
          const cx = parseFloat(el.getAttribute("cx") || "0");
          const cy = parseFloat(el.getAttribute("cy") || "0");
          const mids = this.seedCustom(r, i, key);
          mids.splice(idx, 0, { x: cx, y: cy });
          this.scheduleSaveLayout();
          this.refresh();
          return;
        }
        if (started) this.scheduleSaveLayout();
        this.redrawHandles();
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }

  // ---- modo enfoque / referencias ----
  private visibleTables(): Model["tables"] {
    return this.focus && this.focus.size
      ? this.model.tables.filter((x) => this.focus!.has(x.name))
      : this.model.tables;
  }

  private redrawNodes() {
    while (this.nodeLayer.firstChild)
      this.nodeLayer.removeChild(this.nodeLayer.firstChild);
    this.drawNodes();
  }

  private updateFocusUI() {
    // el dropdown refleja el estado de enfoque actual (si está abierto)
    if (this.dropdownPanel && this.dropdownPanel.style.display === "block")
      this.refreshDropdown(this.ddSearchValue());
    // botones del toolbar: "Quitar todas"/"Salir" solo mientras ha modo enfoque
    const active = this.exploring;
    this.focusBtn?.classList.toggle("on", active);
    if (this.clearAllBtn) this.clearAllBtn.style.display = active ? "" : "none";
    if (this.exitBtn) this.exitBtn.style.display = active ? "" : "none";
  }

  private ddSearchValue(): string {
    return this.dropdownPanel?.querySelector<HTMLInputElement>(".dbml-dd-search")
      ?.value ?? "";
  }

  private toggleDropdown() {
    if (this.dropdownPanel?.style.display === "block") this.closeDropdown();
    else this.openDropdown();
  }

  private openDropdown() {
    if (!this.dropdownPanel) return;
    this.refreshDropdown("");
    this.dropdownPanel.style.display = "block";
    const beforeFocus = this.watchedTable;
    const input = this.dropdownPanel.querySelector<HTMLInputElement>(
      ".dbml-dd-search"
    );
    if (input) input.focus();
    if (beforeFocus) {
      // marca visualmente la fila vigilada
      this.dropdownPanel
        .querySelectorAll(".dbml-dd-row")
        .forEach((r) => r.classList.remove("watched"));
      const row = this.dropdownPanel.querySelector<HTMLElement>(
        `[data-table="${CSS.escape(beforeFocus)}"]`
      );
      if (row) row.classList.add("watched");
    }
  }

  private closeDropdown() {
    this.endHoverWatch();
    if (this.dropdownPanel) this.dropdownPanel.style.display = "none";
  }

  // ---- menú de zooms estándar (clic en el porcentaje de la barra) ----
  private toggleZoomMenu() {
    if (this.zoomMenu?.style.display === "block") this.closeZoomMenu();
    else this.openZoomMenu();
  }

  private openZoomMenu() {
    if (!this.hostEl || !this.zoomPct) return;
    this.closeZoomMenu();
    const menu = this.hostEl.createDiv({ cls: "dbml-zoom-menu" });
    this.zoomMenu = menu;
    const levels = [25, 50, 75, 90, 100, 125, 150, 200, 300, 400];
    const cur = Math.round(this.view.k * 100);
    for (const p of levels) {
      const it = menu.createDiv({ cls: "dbml-zoom-menu-item" });
      it.textContent = p + "%";
      if (p === cur) it.classList.add("active");
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setZoomPct(p);
      });
    }
    menu.style.display = "block";
  }

  private closeZoomMenu() {
    this.zoomMenu?.remove();
    this.zoomMenu = undefined;
  }

  // zoom a un porcentaje estándar manteniendo el centro del lienzo fijo.
  private setZoomPct(pct: number) {
    const r = this.hostEl?.getBoundingClientRect();
    if (r && r.width > 0) {
      const f = pct / 100 / this.view.k;
      const cx = r.width / 2;
      const cy = r.height / 2;
      this.view.x = cx - (cx - this.view.x) * f;
      this.view.y = cy - (cy - this.view.y) * f;
      this.view.k *= f;
    } else {
      this.view.k = pct / 100;
    }
    this.view.k = Math.max(
      Diagram.MIN_ZOOM,
      Math.min(Diagram.MAX_ZOOM, this.view.k)
    );
    this.applyView();
    this.scheduleSaveLayout();
    this.closeZoomMenu();
  }

  // reconstruye el contenido del dropdown (buscador + secciones según `q`).
  private refreshDropdown(q: string) {
    if (!this.dropdownPanel) return;
    this.dropdownPanel.empty();
    const query = q.trim().toLowerCase();

    const search = this.dropdownPanel.createEl("input", {
      cls: "dbml-dd-search",
    });
    search.placeholder = t("searchTable");
    search.value = q;
    search.addEventListener("input", () =>
      this.refreshDropdown(search.value)
    );
    search.addEventListener("click", (e) => e.stopPropagation());

    const focused = this.focus
      ? this.model.tables.filter((x) => this.focus!.has(x.name))
      : [];
    // las enfocadas se listan solo sin búsqueda activa
    const showFocused = !query && focused.length > 0;
    if (showFocused) {
      this.dropdownPanel.createDiv({
        cls: "dbml-dd-section",
        text: t("focusedTables"),
      });
      focused.forEach((x) => this.addDdRow(x, true, search));
    }
    const others = this.model.tables.filter(
      (x) => !focused.includes(x)
    );
    const rest = others.filter((x) => x.name.toLowerCase().includes(query));
    if (!query || rest.length) {
      this.dropdownPanel.createDiv({
        cls: "dbml-dd-section",
        text: t("allTables"),
      });
      rest.slice(0, 60).forEach((x) => this.addDdRow(x, false, search));
    }
    const total = (showFocused ? focused.length : 0) + rest.length;
    if (!total) {
      this.dropdownPanel.createDiv({
        cls: "dbml-dd-empty",
        text: t("noResults"),
      });
    }
    // al reconstruir el panel en cada pulsación el input se destruye y se pierde
    // el foco/caret: si el dropdown sigue abierto, restaurar ambos al final.
    if (this.dropdownPanel.style.display === "block") {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  // una fila del dropdown: el nombre vigila la tabla; el botón ✕/+ alterna el
  // enfoque; botón medio también alterna.
  private addDdRow(
    tbl: Table,
    inFocus: boolean,
    search: HTMLInputElement
  ) {
    if (!this.dropdownPanel) return;
    const row = this.dropdownPanel.createDiv({
      cls: "dbml-dd-row" + (inFocus ? " focused" : ""),
    });
    row.setAttribute("data-table", tbl.name);
    if (this.watchedTable === tbl.name) row.classList.add("watched");
    const label = row.createSpan({ cls: "dbml-dd-name", text: tbl.name });
    label.title = tbl.name;
    // hover: "vigilancia temporal" — mientras el cursor pasa por la fila se
    // centra la tabla (peek); al salir del panel se vuelve a la cámara previa
    // (endHoverWatch). La cámara previa se guarda solo con el primer hover.
    row.addEventListener("mouseenter", () => {
      if (!this.hoverCamera) {
        this.hoverCamera = {
          x: this.view.x,
          y: this.view.y,
          k: this.view.k,
        };
      }
      this.hoveredTable = tbl.name;
      this.centerCameraOn(tbl.name);
    });
    row.addEventListener("mouseleave", () => {
      if (this.hoveredTable === tbl.name) this.hoveredTable = null;
    });
    // click en la fila: vigilar la tabla (mínimo pan para mostrarla entera).
    // El clic concluye la sesión de hover: la cámara que deje el reveal es la
    // definitiva y no debe revertirse al sacar el cursor.
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hoverCamera = null;
      this.hoveredTable = null;
      this.revealTable(tbl.name);
      this.markDdWatched(tbl.name);
    });
    // botón medio: alternar el enfoque de la tabla
    row.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFocusTable(tbl.name);
        this.refreshDropdown(search.value);
      }
    });
    const act = row.createEl("button", {
      cls: "dbml-dd-act",
      text: inFocus ? "✕" : "+",
    });
    act.title = inFocus ? t("removeFromFocus") : t("addToFocus");
    act.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleFocusTable(t.name);
      this.refreshDropdown(search.value);
    });
  }

  private markDdWatched(name: string) {
    this.dropdownPanel
      ?.querySelectorAll(".dbml-dd-row")
      .forEach((r) => r.classList.toggle("watched", r.getAttribute("data-table") === name));
  }

  // añade la tabla al modo enfoque SIN reemplazar el conjunto existente (multi
  // tabla); si ya está enfocada la quita (y si era la última, sale del modo).
  private toggleFocusTable(name: string) {
    const entering = !this.focus;
    if (this.focus && this.focus.has(name)) {
      this.focus.delete(name);
      if (this.focus.size === 0) {
        this.fitAll(); // vuelve al modo normal
        return;
      }
      this.saveFocusState();
      this.applyFocusView();
      return;
    }
    if (!this.focus) this.focus = new Set<string>();
    this.focus.add(name);
    this.saveFocusState();
    this.applyFocusView(entering);
  }

  // banda al navegador del toolbar: tabla anterior/siguiente (alfabético).
  private stepTable(dir: number) {
    const names = this.model.tables
      .map((x) => x.name)
      .sort((a, b) => a.localeCompare(b));
    if (!names.length) return;
    const cur = this.watchedTable ?? names[0];
    let idx = names.indexOf(cur);
    if (idx < 0) idx = 0;
    this.revealTable(names[(idx + dir + names.length) % names.length]);
  }

  // aplica el modo enfoque: provisionalmente la fila compacta mientras ELK
// calcula el jerárquico L→R del subconjunto. `entering` marca la transición
// modo normal → enfoque: guarda la cámara normal y, la próxima vez, restaura
// la cámara del enfoque (o encuadra todo el subconjunto la primera vez).
  private applyFocusView(entering = false) {
    if (entering) {
      this.normalCamera = { x: this.view.x, y: this.view.y, k: this.view.k };
    }
    this.closeRefPanel();
    this.layoutPos = this.layoutCompact(this.focus ?? new Set<string>());
    this.redrawNodes();
    this.redrawEdges();
    this.redrawHandles();
    this.updateFocusUI();
    if (entering && this.focusCamera) {
      this.view = { ...this.focusCamera };
      this.applyView();
      this.redrawHandles();
    } else {
      this.fit(false);
    }
    // sistema de layout propio del modo enfoque: jerárquico (L→R) al añadir/quitar
    void this.reflowFocus();
  }

  // añade la tabla al modo enfoque SIN reemplazar el conjunto existente (multi
  // tabla). Si ya está enfocada se quita; si era la última, sale del modo.
  private focusTable(name: string) {
    this.toggleFocusTable(name);
  }

  // clic medio en arista/badge: trae la tabla referenciada junto a la actual
  // (ambas a cuadro) sin descartar otras tablas ya enfocadas.
  private focusPair(a: string, b: string) {
    const entering = !this.focus;
    if (!this.focus) this.focus = new Set<string>();
    this.focus.add(a);
    this.focus.add(b);
    this.saveFocusState();
    this.applyFocusView(entering);
  }

  // persiste el estado de enfoque en el plugin para que sobreviva a re-renders
  // (guardar layout con vault.process re-renderiza el bloque) y en el archivo
  // como anotación `// @focusOn` (el "fondo" de la nota: sobrevive a recargas).
  private saveFocusState() {
    if (!this.plugin || !this.selKey) return;
    if (this.focus && this.focus.size) {
      this.plugin.focusState.set(this.selKey, [...this.focus]);
    } else {
      this.plugin.focusState.delete(this.selKey);
    }
    this.scheduleSaveFocus();
  }

  private focusSaveTimer = 0;
  // escribe la anotación @focusOn con el conjunto actual (o la borra al salir).
  // No pasa por saveLayout: esa ruta se pausa durante el enfoque.
  private scheduleSaveFocus() {
    if (this.focusSaveTimer) activeWindow.clearTimeout(this.focusSaveTimer);
    this.focusSaveTimer = activeWindow.setTimeout(
      () => void this.saveFocusAnnot(),
      400
    );
  }

  private async saveFocusAnnot() {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    const data = await this.plugin.app.vault.read(file);
    const next = this.buildFocusContent(data, info.lineStart);
    if (next === null || next === data) return;
    await this.plugin.app.vault.process(
      file,
      (d) => this.buildFocusContent(d, info.lineStart) ?? d
    );
  }

  // reconstruye el bloque sustituyendo la anotación @focusOn (la elimina si el
  // modo enfoque está inactivo). Devuelve null si no se encuentra el bloque.
  private buildFocusContent(data: string, lineStart: number): string | null {
    const lines = data.split("\n");
    const range = this.blockRange(lines, lineStart);
    if (!range) return null;
    const [open, close] = range;
    const names = this.focus ? [...this.focus] : [];
    const body = lines
      .slice(open + 1, close)
      .filter((l) => !/^\s*\/\/\s*@focusOn\b/.test(l));
    const insert = names.length ? [focusOnLine(names)] : [];
    return [
      ...lines.slice(0, open + 1),
      ...body,
      ...insert,
      ...lines.slice(close),
    ].join("\n");
  }

  // estado de enfoque actual (copia), para la anotación @focusOn al guardar la
  // ventana (writeBack) desde el Diagram montado dentro del Modal.
  getFocusedTables(): string[] {
    return this.focus ? [...this.focus] : [];
  }

  // ⊡ del toolbar o menú "Show all": vuelve al diagrama completo.
  // `remember` = conservar el conjunto enfocado para restaurarlo al re-activar
  // el modo (⊞ / clic medio en el vacío). "Quitar todas" pasa false.
  private fitAll(remember = true) {
    const hadFocus = !!this.focus;
    // al salir del modo enfoque se recuerda su cámara (para volver a ella al
    // re-entrar) y se restaura la cámara del modo normal que había al entrar.
    if (hadFocus) {
      this.focusCamera = { x: this.view.x, y: this.view.y, k: this.view.k };
      this.lastFocusTables =
        remember && this.focus && this.focus.size ? [...this.focus] : null;
    }
    this.focus = null;
    this.closeRefPanel();
    this.layoutPos = null; // descarta el arreglo compacto
    if (hadFocus) {
      this.endHoverWatch();
      this.saveFocusState();
      this.redrawNodes();
      this.redrawEdges();
      this.redrawHandles();
      this.updateFocusUI();
      if (this.normalCamera) {
        this.view = { ...this.normalCamera };
        this.applyView();
        this.redrawHandles();
        return;
      }
    }
    this.fit(true);
  }

  private exitFocus() {
    if (!this.focus) {
      this.closeRefPanel();
      return;
    }
    this.fitAll();
  }

  // Vigila una tabla concreta SIN mover la vista: traer/ver una clase en el GUI
// no debe hacer saltar el pan/zoom (sin "zoom jumping"). Marca ".dbml-node-live"
// y actualiza el navegador. En modo enfoque NO se sale: la tabla se añade al
// conjunto (si no estaba) y se vigila igualmente, recalculando el layout
// jerárquico L→R del conjunto actualizado.
  revealTable(name: string) {
    if (!this.pos[name]) return;
    this.watchedTable = name;
    this.watchedEdgeKey = null;
    this.markLiveRow(null, null);
    if (this.focus && !this.focus.has(name)) {
      this.focus.add(name);
      this.layoutPos = this.layoutCompact(this.focus);
      this.saveFocusState();
      void this.reflowFocus();
    }
    this.redrawNodes();
    this.redrawEdges();
    this.redrawHandles();
    this.updateFocusUI();
    // vigilar ya no salta ni hace zoom: solo el mínimo pan si la tabla no está
    // del todo en el marco (si ya cabe entera, la cámara NO se mueve)… salvo
    // por el SUELO de zoom: si estás por debajo del 75%, vigilar sube a 100%
    // y coloca la tabla en el centro (si no, te quedas donde estás a nivel zoom).
    const kBefore = this.view.k;
    this.ensureTableVisible(name);
    if (kBefore < 0.75) this.centerCameraOn(name);
  }

  // Deshace una "vigilancia temporal" de hover: restaura la cámara que había
  // antes del primer hover del ratón. No-op si no había ninguna en curso.
  private endHoverWatch() {
    if (this.hoverCamera) {
      this.view = { ...this.hoverCamera };
      this.applyView();
      this.redrawHandles();
    }
    this.hoverCamera = null;
    this.hoveredTable = null;
  }

  // centra la tabla en el lienzo a zoom 100% (o el máximo que la deje entera)…
  // usada SOLO por el hover temporal del dropdown (peek).
  private centerCameraOn(name: string) {
    const P = this.px(name);
    if (!P) return;
    const r = this.svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const t = this.model.tables.find((x) => x.name === name);
    const w = P.w || NODE_W;
    const h = P.h || HEAD_H + (t ? t.cols.length * ROW_H : 0);
    const k = isFinite(Math.min(1, (r.width - 24) / w, (r.height - 24) / h))
      ? Math.min(1, (r.width - 24) / w, (r.height - 24) / h)
      : 1;
    this.view.k = k > 0 ? k : 0.25;
    this.view.x = r.width / 2 - (P.x + w / 2) * this.view.k;
    this.view.y = r.height / 2 - (P.y + h / 2) * this.view.k;
    this.applyView();
    this.redrawHandles();
  }

// Mueve la cámara lo MÍNIMO para mostrar la tabla CON un poco de aire
// alrededor, sin zoom y con el menor cambio posible en pantalla: si ya cabe
// completa en el marco no hace nada (ni un píxel, ni siquiera para ganar
// margen); solo cuando hay que moverse se deja espacio extra alrededor.
  private ensureTableVisible(name: string) {
    const P = this.px(name);
    if (!P) return;
    const r = this.svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const t = this.model.tables.find((x) => x.name === name);
    const w = P.w || NODE_W;
    const h = P.h || HEAD_H + (t ? t.cols.length * ROW_H : 0);
    const k = this.view.k;
    const left = P.x,
      right = P.x + w;
    const top = P.y,
      bot = P.y + h;
    // mundo visible actualmente por el viewport (en coordenadas del mundo)
    const vLeft = -this.view.x / k;
    const vTop = -this.view.y / k;
    const vRight = (-this.view.x + r.width) / k;
    const vBot = (-this.view.y + r.height) / k;
    // tabla ya completamente dentro del marco → no mover nada
    if (
      left >= vLeft &&
      right <= vRight &&
      top >= vTop &&
      bot <= vBot
    )
      return;
    // hace falta barrer la cámara: se encuadra dejando aire (m px) a cada lado
    const m = 40;
    // d = desplazamiento del borde izdo del viewport (positivo = a la derecha)
    const dLoX = right > vRight - m ? right - (vRight - m) : -Infinity;
    const dHiX = left < vLeft + m ? left - (vLeft + m) : Infinity;
    let dX: number;
    if (dLoX <= dHiX) dX = dLoX > 0 ? dLoX : dHiX < 0 ? dHiX : 0;
    else dX = (left + right) / 2 - (vLeft + vRight) / 2;
    const dLoY = bot > vBot - m ? bot - (vBot - m) : -Infinity;
    const dHiY = top < vTop + m ? top - (vTop + m) : Infinity;
    let dY: number;
    if (dLoY <= dHiY) dY = dLoY > 0 ? dLoY : dHiY < 0 ? dHiY : 0;
    else dY = (top + bot) / 2 - (vTop + vBot) / 2;
    if ((dX === 0 && dY === 0) || !isFinite(dX) || !isFinite(dY)) return;
    this.view.x -= dX * k;
    this.view.y -= dY * k;
    this.applyView();
    this.redrawHandles();
  }

  private focusLayoutToken = 0;
  // Sistema de layout PROPIO del modo enfoque: jerárquico (L→R), recalculado
  // con ELK sobre el subconjunto enfocado CADA vez que se añade o quita una
  // tabla (frente a la fila compacta provisional). No cambia pan/zoom.
  private async reflowFocus() {
    const set = this.focus;
    if (!set || !set.size) return;
    const tables = this.model.tables.filter((x) => set.has(x.name));
    if (!tables.length) return;
    const refs = this.model.refs.filter(
      (r) => set.has(r.from) && set.has(r.to)
    );
    const tok = ++this.focusLayoutToken;
    let lay: LayoutResult;
    try {
      lay = await computeLayout({ tables, refs }, "layered-lr");
    } catch {
      return;
    }
    if (tok !== this.focusLayoutToken || !this.focus || this.focus !== set)
      return;
    // normaliza el origen del layout del subconjunto al (0,0) del lienzo
    let minX = 1e9,
      minY = 1e9;
    for (const n of Object.values(lay.nodes)) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
    }
    const off = 30;
    const map: Record<
      string,
      { x: number; y: number; w: number; h: number }
    > = {};
    for (const [k, n] of Object.entries(lay.nodes)) {
      map[k] = { x: n.x - minX + off, y: n.y - minY + off, w: n.w, h: n.h };
    }
    this.layoutPos = map;
    this.redrawNodes();
    this.redrawEdges();
    this.redrawHandles();
  }

  // ⊞ del toolbar / clic medio sobre el vacío: alterna el modo enfoque.
  // Salir: vuelve al diagrama completo guardando la cámara y el conjunto.
  // Entrar: enfoca la tabla vigilada (o la primera) O, si quedó un conjunto
  // enfocado recordado al salir, lo restaura tal cual.
  private toggleFocusMode() {
    if (this.exploring) {
      this.exitFocus();
      return;
    }
    const prior = this.lastFocusTables;
    if (prior && prior.length) {
      this.focus = new Set(prior);
      this.saveFocusState();
      this.applyFocusView(true);
      return;
    }
    const first = this.watchedTable ?? this.model.tables[0]?.name;
    if (!first) return;
    this.focus = new Set([first]);
    this.saveFocusState();
    this.applyFocusView(true);
  }

  // el candado del layout impide arrastrar las tablas (editores externos)
  setLayoutLocked(locked: boolean) {
    this.layoutLocked = locked;
    this.hostEl?.classList.toggle("dbml-locked", locked);
  }

  // resalta la última arista usada para vigilar/emigrar a otra tabla.
  watchEdge(key: string) {
    this.watchedEdgeKey = key;
    this.redrawEdges();
  }

  // recorta el nombre de la cabecera para que no invada los contadores.
  private fitToPx(s: string, maxPx: number): string {
    const max = Math.floor(maxPx / 7.6);
    if (max <= 0) return "…";
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + "…";
  }

  // contadores "→n" (salientes) y "←n" (entrantes) en la cabecera de la tabla;
  // su tooltip detalla qué tabla·propiedad referencia.
  private drawRefBadges(g: SVGGElement, table: string, outN: number, inN: number) {
    const bh = 16,
      y = (HEAD_H - bh) / 2;
    let right = NODE_W - 6;
    const badge = (dir: "in" | "out", n: number) => {
      const bw = 14 + (1 + String(n).length) * 8;
      const bg = activeDocument.createElementNS(NS, "g");
      bg.classList.add("dbml-ref-badge", dir);
      bg.setAttribute("data-dir", dir);
      const tt = activeDocument.createElementNS(NS, "title");
      tt.textContent = this.badgeLabel(table, dir);
      bg.appendChild(tt);
      const r = this.rect(right - bw, y, bw, bh, "dbml-ref-badge-bg");
      r.setAttribute("rx", "8");
      bg.appendChild(r);
      const txt = this.text(
        right - bw + 7,
        y + bh / 2 + 3.5,
        `${dir === "in" ? "←" : "→"}${n}`,
        "dbml-ref-badge-txt"
      );
      bg.appendChild(txt);
      g.appendChild(bg);
      right -= bw + 4;
    };
    if (outN > 0) badge("out", outN);
    if (inN > 0) badge("in", inN);
  }

  // panel desplegable con la lista de referencias entrantes/salientes. Cada fila:
  // clic izdo -> foco en esa tabla; clic derecho -> foco en ambas (tabla + ref).
  // panel desplegable con la lista de referencias entrantes/salientes de la
  // tabla (o solo de la columna `col` si se abrió desde un badge de columna).
  // Cada fila: clic izdo -> vigilar esa tabla; botón medio -> enfocar ambas.
  private openRefPanel(
    table: string,
    dir: "in" | "out",
    col: string | null,
    evt: PointerEvent
  ) {
    if (!this.hostEl) return;
    this.closeRefPanel();
    const panel = this.hostEl.createDiv({ cls: "dbml-refpanel" });
    this.refPanel = panel;

    const headKey =
      dir === "out"
        ? t("refHeadingOut", { table })
        : t("refHeadingIn", { table });
    const all = this.model.refs.filter((r) =>
      dir === "out" ? r.from === table : r.to === table
    );
    const refs = col
      ? all.filter((r) =>
          dir === "out" ? r.fromCol === col : r.toCol === col
        )
      : all;
    panel.createDiv({
      cls: "dbml-refpanel-head",
      text: col ? `${headKey} · ${col}` : headKey,
    });
    if (!refs.length) {
      panel.createDiv({ cls: "dbml-refpanel-empty", text: t("refNoRefs") });
    }
    refs.forEach((r) => {
      const target = dir === "out" ? r.to : r.from;
      const row = panel.createDiv({ cls: "dbml-refpanel-row" });
      // la clase ya enfocada se remarca: así se ve de un vistazo qué destinos
      // del badge pertenecen ya al modo enfoque.
      if (this.focus?.has(target)) row.classList.add("focused");
      row.setAttribute("data-table", target);
      row.createSpan({
        cls: "dbml-refpanel-arrow",
        text: dir === "out" ? "→" : "←",
      });
      const info = row.createDiv({ cls: "dbml-refpanel-main" });
      info.createDiv({ cls: "dbml-refpanel-target", text: target });
      const cols =
        dir === "out"
          ? `${r.from}.${r.fromCol} → ${r.to}.${r.toCol}`
          : `${r.to}.${r.toCol} ← ${r.from}.${r.fromCol}`;
      info.createDiv({ cls: "dbml-refpanel-cols", text: cols });
      row.title = t("refHint");
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.revealTable(target);
        this.watchEdge(this.edgeKey(r));
      });
      row.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          this.focusPair(table, target);
        }
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    const hostRect = this.hostEl.getBoundingClientRect();
    let px = evt.clientX - hostRect.left;
    let py = evt.clientY - hostRect.top;
    panel.style.left = px + "px";
    panel.style.top = py + "px";
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    panel.style.left = Math.max(6, Math.min(px, hostRect.width - pw - 6)) + "px";
    panel.style.top = Math.max(6, Math.min(py, hostRect.height - ph - 6)) + "px";

    const onAway = (e: PointerEvent) => {
      const tgt = e.target as Element;
      if (tgt.closest?.(".dbml-refpanel")) return;
      this.closeRefPanel();
    };
    activeDocument.addEventListener("pointerdown", onAway, true);
    activeDocument.addEventListener("contextmenu", onAway, true);
    this.refPanelCleanup = () => {
      activeDocument.removeEventListener("pointerdown", onAway, true);
      activeDocument.removeEventListener("contextmenu", onAway, true);
    };
  }

  private closeRefPanel() {
    this.refPanel?.remove();
    this.refPanel = undefined;
    if (this.refPanelCleanup) {
      this.refPanelCleanup();
      this.refPanelCleanup = undefined;
    }
  }

  // ---- dibujo de nodos ----
  private drawNodes() {
    this.model.tables.forEach((t) => {
      const P = this.px(t.name);
      if (!P) return;
      // modo enfoque: oculta el resto de tablas
      if (this.focus && !this.focus.has(t.name)) return;
      const g = activeDocument.createElementNS(NS, "g");
      g.classList.add("dbml-node");
      if (this.focus) g.classList.add("dbml-node-focus");
      if (this.watchedTable === t.name) g.classList.add("dbml-node-live");
      g.setAttribute("transform", `translate(${P.x},${P.y})`);
      g.setAttribute("data-table", t.name);
      // nota de tabla: tooltip nativo al pasar el ratón por la cabecera (y por
      // cualquier fila sin nota propia, ya que <title> busca el ancestro más
      // cercano con tooltip).
      if (t.note) {
        const tt = activeDocument.createElementNS(NS, "title");
        tt.textContent = t.note;
        g.appendChild(tt);
      }
      const h = HEAD_H + t.cols.length * ROW_H;

      const body = this.rect(0, 0, NODE_W, h, "dbml-body");
      body.setAttribute("rx", "6");
      g.appendChild(body);

      const head = this.rect(0, 0, NODE_W, HEAD_H, "dbml-head");
      head.setAttribute("rx", "6");
      g.appendChild(head);
      const headFix = this.rect(0, HEAD_H - 8, NODE_W, 8, "dbml-head");
      g.appendChild(headFix);
      const outN = this.model.refs.filter((r) => r.from === t.name).length;
      const inN = this.model.refs.filter((r) => r.to === t.name).length;
      const badgeW = (n: number) =>
        n > 0 ? 14 + (1 + String(n).length) * 8 + 4 : 0;
      const reserve = badgeW(outN) + badgeW(inN) + 6;
      const shown = this.fitToPx(t.name, NODE_W - 14 - reserve);
      const headTxt = this.text(14, HEAD_H / 2 + 4, shown, "dbml-head-txt");
      if (shown !== t.name) {
        const tt = activeDocument.createElementNS(NS, "title");
        tt.textContent = t.name;
        headTxt.appendChild(tt);
      }
      g.appendChild(headTxt);
      if (t.headerColor) {
        // variables CSS (no estilos estáticos inline): styles.css las consume
        g.style.setProperty("--dbml-head-fill", t.headerColor);
        const tc = this.readableText(t.headerColor);
        if (tc) g.style.setProperty("--dbml-head-txt-fill", tc);
      }
      this.drawRefBadges(g, t.name, outN, inN);

      t.cols.forEach((c, i) => {
        // grupo por fila: su <title> convierte el hover de toda la columna en
        // el tooltip de su nota (el ancestro más cercano gana sobre la tabla).
        const cg = activeDocument.createElementNS(NS, "g");
        cg.setAttribute("data-col", String(i));
        if (c.note) {
          const tt = activeDocument.createElementNS(NS, "title");
          tt.textContent = `${c.name} — ${c.note}`;
          cg.appendChild(tt);
        }
        g.appendChild(cg);

        const rr = this.rect(
          1,
          HEAD_H + i * ROW_H,
          NODE_W - 2,
          ROW_H,
          i % 2 ? "dbml-row alt" : "dbml-row"
        );
        rr.setAttribute("data-col", String(i));
        cg.appendChild(rr);

        const y = HEAD_H + i * ROW_H + ROW_H / 2 + 4;
        const nm = this.text(14, y, c.name, c.pk ? "dbml-col pk" : "dbml-col");
        nm.setAttribute("data-col", String(i));
        cg.appendChild(nm);
        // PK: el nombre en negrita + subrayado. Sin iconos ni emojis en las
        // propiedades: una FK se transmite solo con los badges de referencia.
        // badges de referencia por columna (misma lógica que la cabecera pero
        // específica de esta propiedad): se apilan a la derecha, antes del tipo.
        const colOut = this.model.refs.filter(
          (r) => r.from === t.name && r.fromCol === c.name
        ).length;
        const colIn = this.model.refs.filter(
          (r) => r.to === t.name && r.toCol === c.name
        ).length;
        let rightX = NODE_W - 14;
        const colRefBadge = (dir: "in" | "out", n: number) => {
          const bw = 14 + (1 + String(n).length) * 8;
          const bg = activeDocument.createElementNS(NS, "g");
          bg.classList.add("dbml-ref-badge", dir);
          bg.setAttribute("data-dir", dir);
          bg.setAttribute("data-col", String(i));
          const tt = activeDocument.createElementNS(NS, "title");
          tt.textContent = this.badgeLabel(t.name, dir, c.name);
          bg.appendChild(tt);
          const r = this.rect(rightX - bw, y - 13, bw, 15, "dbml-ref-badge-bg");
          r.setAttribute("rx", "8");
          r.setAttribute("data-col", String(i));
          bg.appendChild(r);
          const txt = this.text(
            rightX - bw + 7,
            y - 1.5,
            `${dir === "in" ? "←" : "→"}${n}`,
            "dbml-ref-badge-txt"
          );
          txt.setAttribute("data-col", String(i));
          bg.appendChild(txt);
          cg.appendChild(bg);
          rightX -= bw + 4;
        };
        if (colOut > 0) colRefBadge("out", colOut);
        if (colIn > 0) colRefBadge("in", colIn);
        if (c.nn) {
          const bw = 22;
          const b = this.rect(rightX - bw, y - 13, bw, 15, "dbml-badge");
          b.setAttribute("rx", "3");
          b.setAttribute("data-col", String(i));
          cg.appendChild(b);
          const bt = this.text(rightX - bw / 2, y - 1.5, "NN", "dbml-badge-txt");
          bt.setAttribute("data-col", String(i));
          cg.appendChild(bt);
          rightX -= bw + 8;
        }
        const ty = this.text(rightX, y, c.type, "dbml-type");
        ty.setAttribute("data-col", String(i));
        cg.appendChild(ty);
      });

      if (this.interactive) this.enableDrag(g, t.name);
      this.nodeLayer.appendChild(g);
    });
  }

  // elige color de texto legible (blanco u oscuro) según la luminancia del fondo.
  // Resuelve hex/rgb()/hsl()/nombres normalizando con un canvas.
  private readableText(color: string): string {
    const rgb = this.toRgb(color);
    if (!rgb) return "#ffffff";
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return lum > 0.6 ? "#1a1a1a" : "#ffffff";
  }

  private static colorCtx?: CanvasRenderingContext2D | null;
  private toRgb(color: string): [number, number, number] | null {
    const raw = color.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
      const h = raw
        .split("")
        .map((c) => c + c)
        .join("");
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw))
      return [
        parseInt(raw.slice(0, 2), 16),
        parseInt(raw.slice(2, 4), 16),
        parseInt(raw.slice(4, 6), 16),
      ];
    // rgb()/hsl()/nombre: normaliza con canvas
    if (Diagram.colorCtx === undefined) {
      const cv = activeDocument.createElement("canvas");
      cv.width = cv.height = 1;
      Diagram.colorCtx = cv.getContext("2d");
    }
    const ctx = Diagram.colorCtx;
    if (!ctx) return null;
    ctx.fillStyle = "#000000";
    ctx.fillStyle = color;
    const norm = ctx.fillStyle; // "#rrggbb" o "rgba(r, g, b, a)"
    if (norm.startsWith("#")) {
      const h = norm.slice(1);
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    const mm = norm.match(/(\d+(?:\.\d+)?)/g);
    if (mm && mm.length >= 3)
      return [Number(mm[0]), Number(mm[1]), Number(mm[2])];
    return null;
  }

  private rect(x: number, y: number, w: number, h: number, cls: string) {
    const r = activeDocument.createElementNS(NS, "rect");
    r.setAttribute("x", "" + x);
    r.setAttribute("y", "" + y);
    r.setAttribute("width", "" + w);
    r.setAttribute("height", "" + h);
    cls.split(" ").forEach((c) => c && r.classList.add(c));
    return r;
  }
  private text(x: number, y: number, str: string, cls: string) {
    const t = activeDocument.createElementNS(NS, "text");
    t.setAttribute("x", "" + x);
    t.setAttribute("y", "" + y);
    cls.split(" ").forEach((c) => c && t.classList.add(c));
    t.textContent = str;
    return t;
  }

  // ---- interacción ----
  // escribe el índice de columna bajo el cursor (o -1) resolviendo en el grupo
  // de fila más cercano (data-col). Los badges de columna llevan data-col; los
  // de cabecera no (null).
  private elemCol(tgt: Element): number {
    const el = tgt.closest?.('[data-col]');
    if (!el) return -1;
    const v = el.getAttribute("data-col");
    const n = v !== null ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) ? n : -1;
  }

  private elemBadge(tgt: Element): { dir: "in" | "out"; col: number | null } | null {
    const b = tgt.closest?.(".dbml-ref-badge");
    if (!b) return null;
    const col = b.getAttribute("data-col");
    const dir = b.getAttribute("data-dir") === "in" ? "in" : "out";
    return { dir, col: col !== null ? parseInt(col, 10) : null };
  }

  // refs que apuntan a la tabla/columna en la dirección dada.
  private badgeRefs(
    name: string,
    dir: "in" | "out",
    col?: string | null
  ): Ref[] {
    return this.model.refs.filter((r) =>
      dir === "out"
        ? r.from === name && (!col || r.fromCol === col)
        : r.to === name && (!col || r.toCol === col)
    );
  }

  // tablas alcanzables desde un badge (sin duplicados).
  private badgeTables(refs: Ref[], dir: "in" | "out"): string[] {
    const s = new Set<string>();
    for (const r of refs) s.add(dir === "out" ? r.to : r.from);
    return [...s];
  }

  // rótulo de un badge (cabecera o columna) = qué tabla y qué columna de la
  // otra tabla referencia. Con varias referencias se listan separadas.
  private badgeLabel(name: string, dir: "in" | "out", col?: string | null): string {
    const refs = this.badgeRefs(name, dir, col);
    if (!refs.length) return dir === "in" ? t("refInBadge", { n: "0" }) : t("refOutBadge", { n: "0" });
    const names =
      dir === "out"
        ? refs.map((r) => `${r.to}.${r.toCol}`)
        : refs.map((r) => `${r.from}.${r.fromCol}`);
    return names.join("\n");
  }

  // clic sobre un badge de referencias (cabecera de tabla o columna):
  //  - una única referencia: realiza la acción equivalente (botón izdo/dcho =
  //    vigilar la tabla referenciada; botón medio = enfocar ambas).
  //  - varias referencias: abre el panel selector para elegir.
  private handleBadgeClick(
    name: string,
    badge: { dir: "in" | "out"; col: number | null },
    button: number,
    evt: PointerEvent
  ) {
    const col =
      badge.col !== null && badge.col >= 0
        ? this.model.tables.find((x) => x.name === name)?.cols[badge.col!]?.name ??
          null
        : null;
    const refs = this.badgeRefs(name, badge.dir, col);
    const targets = this.badgeTables(refs, badge.dir);
    if (targets.length !== 1) {
      // varias referencias: abrir el panel selector (cerrándolo antes de que
      // el pointerdown de apertura se propague y lo cierre él mismo)
      evt.stopPropagation();
      evt.preventDefault();
      const dir = badge.dir;
      setTimeout(
        () => this.openRefPanel(name, dir, col, evt),
        0
      );
      return;
    }
    const other = targets[0];
    if (button === 1) {
      // clic medio: enfocar ambas tablas
      this.focusPair(name, other);
    } else {
      // clic izdo/dcho: vigilar la tabla referenciada
      this.revealTable(other);
      this.watchEdge(this.edgeKey(refs[0]));
    }
  }

  // acciones por botón en un nodo de tabla (cabecera, fila o badge):
  //  izdo  = mover la tabla (si no está bloqueado)
  //  dcho  = vigilar la tabla (centrar + mostrar todo)
  //  medio = alternar el enfoque de la tabla
  private enableDrag(g: SVGGElement, name: string) {
    let sx = 0,
      sy = 0,
      ox = 0,
      oy = 0,
      dragging = false,
      moved = false;
    let colIdx = -1;
    let badge: { dir: "in" | "out"; col: number | null } | null = null;
    // pieza sobre la que se pulsó: clase, nombre de propiedad o su tipo.
    let targetPart: "class" | "name" | "type" = "class";
    // Pointer capture: mv/up se enganchan al propio nodo (elemento propio que
    // se libera con el DOM al descargar), no a window -> sin fugas de listeners.
    g.addEventListener("pointerdown", (ev: PointerEvent) => {
      const tgt = ev.target as Element;
      badge = this.elemBadge(tgt);
      colIdx = badge ? (badge.col ?? -1) : this.elemCol(tgt);
      targetPart =
        colIdx < 0
          ? "class"
          : tgt.closest?.(".dbml-type")
            ? "type"
            : "name";
      // botón izdo con layout BLOQUEADO y sin badge: no se arrastra la tabla;
      // se deja pasar al pan del lienzo (pointerdown no se detiene aquí).
      const letPan = ev.button === 0 && this.layoutLocked && !badge;
      // solo el botón izquierdo mueve la tabla, y solo si no está bloqueado
      // (ni clic sobre un badge: ese clic es "vigilar/focus", no arrastre).
      dragging = ev.button === 0 && !badge && !this.layoutLocked;
      moved = false;
      // punto de agarre en coordenadas de cliente (no se puede restar 0: el
      // primer pointermove haría saltar la tabla hacia la esquina inferior dcha).
      sx = ev.clientX;
      sy = ev.clientY;
      // en modo enfoque se arrastra la disposición compacta (layoutPos); fuera,
      // la posición original persistida (this.pos).
      const target = this.layoutPos ? this.layoutPos[name] : this.pos[name];
      ox = target?.x ?? 0;
      oy = target?.y ?? 0;
      if (!letPan) {
        ev.stopPropagation();
        ev.preventDefault();
      }
      if (dragging) {
        try {
          g.setPointerCapture(ev.pointerId);
        } catch {
          /* noop */
        }
      }
      const mv = (e: PointerEvent) => {
        if (!dragging) return;
        if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
        moved = true;
        if (!this.layoutPos) this.movedTables.add(name);
        const P = this.layoutPos ? this.layoutPos[name] : this.pos[name];
        if (!P) return;
        P.x = ox + (e.clientX - sx) / this.view.k;
        P.y = oy + (e.clientY - sy) / this.view.k;
        g.setAttribute("transform", `translate(${P.x},${P.y})`);
        this.redrawEdges();
      };
      const up = (e: PointerEvent) => {
        dragging = false;
        g.removeEventListener("pointermove", mv);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        try {
          g.releasePointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        // pan del lienzo en curso (layout bloqueado): dejar que concluya
        if (letPan) return;
        if (moved) {
          this.scheduleSaveLayout();
          return;
        }
        if (e.type === "pointercancel") return;
        e.stopPropagation();
        e.preventDefault();
        const eve = e;
        if (badge) {
          this.handleBadgeClick(name, badge, e.button, eve);
          return;
        }
        if (e.button === 2) {
          // clic derecho: vigilar la TABLA en el diagrama y llevar el cursor del
          // editor a su bloque (columna si el clic fue sobre una fila).
          const col =
            colIdx >= 0
              ? this.model.tables.find((x) => x.name === name)?.cols[colIdx]
                  ?.name ?? null
              : null;
          if (this.onJump) this.onJump(name, col, targetPart);
          else this.revealTable(name);
        } else if (e.button === 1) {
          // clic medio: alternar enfoque
          this.toggleFocusTable(name);
        }
        // botón izquierdo sin arrastre: no hace nada (ya cubierto por el pan)
      };
      g.addEventListener("pointermove", mv);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    // doble clic en nombre de clase / propiedad: vigilar + llevar el cursor del
    // editor a esa línea (solo si hay editor asociado; si no, solo vigilar).
    g.addEventListener("dblclick", (ev: MouseEvent) => {
      const tgt = ev.target as Element;
      if (tgt.closest?.(".dbml-ref-badge")) return;
      const ci = this.elemCol(tgt);
      const col =
        ci >= 0
          ? this.model.tables.find((x) => x.name === name)?.cols[ci]?.name ??
            null
          : null;
      ev.stopPropagation();
      const part: "class" | "name" | "type" =
        ci < 0
          ? "class"
          : tgt.closest?.(".dbml-type")
            ? "type"
            : "name";
      if (this.onJump) this.onJump(name, col, part);
      else this.revealTable(name);
    });
  }

  private isFence(line: string | undefined): boolean {
    return !!line && /^\s*(```|~~~)/.test(line);
  }

  // Valida que lineStart sea una cerca y localiza la cerca de cierre escaneando
  // hacia adelante (robusto a que el bloque haya crecido con líneas @pos/@view
  // desde que se cacheó el sectionInfo). Devuelve [open, close] o null.
  private blockRange(
    lines: string[],
    lineStart: number
  ): [number, number] | null {
    if (!this.isFence(lines[lineStart])) return null;
    for (let i = lineStart + 1; i < lines.length; i++) {
      if (this.isFence(lines[i])) return [lineStart, i];
    }
    return null;
  }

  // ---- edición de textos (rename / tipo) ----
  private async editBlock(
    mutate: (lines: string[], start: number, end: number) => boolean,
    notFoundMsg: string
  ) {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) {
      new Notice(t("locateBlockFail"));
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    let ok = true;
    // vault.process: lectura-modificación-escritura atómica (no pisa ediciones
    // concurrentes entre read y modify).
    await this.plugin.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      const range = this.blockRange(lines, info.lineStart);
      if (!range) {
        ok = false;
        return data;
      }
      if (!mutate(lines, range[0], range[1])) {
        ok = false;
        return data;
      }
      return lines.join("\n");
    });
    if (!ok) new Notice(notFoundMsg);
  }

  // ---- guardado de posiciones / vista ----
  private scheduleSaveLayout() {
    // No persistir mientras el modo enfoque está activo: la disposición compacta
    // y la vista con zoom son transitorias. Guardar aquí dispararía un re-render
    // que destruiría el bloque actual y perdería el enfoque/pantalla completa.
    if (this.focus) return;
    if (this.saveTimer) activeWindow.clearTimeout(this.saveTimer);
    this.saveTimer = activeWindow.setTimeout(() => this.saveLayout(), 600);
  }

  private async saveLayout() {
    if (!this.plugin || !this.ctx || !this.blockEl) return;
    const info = this.ctx.getSectionInfo(this.blockEl);
    if (!info) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(
      this.ctx.sourcePath
    );
    if (!(file instanceof TFile)) return;
    // Evita reescrituras idénticas: cada vault.process dispara un evento
    // "modify" que hace re-renderizar el bloque (nueva instancia => se pierde
    // la selección y parpadea, incluso en bucle). Solo persistimos si el
    // contenido del bloque realmente cambió.
    const current = await this.plugin.app.vault.read(file);
    const next = this.buildLayoutContent(current, info.lineStart);
    if (next === null || next === current) return;
    await this.plugin.app.vault.process(
      file,
      (data) => this.buildLayoutContent(data, info.lineStart) ?? data
    );
  }

  // reconstruye el contenido completo del archivo con las líneas @pos/@view/
  // @size/@edge actualizadas dentro del bloque dbml. Devuelve null si el bloque
  // no se encuentra (no se debe tocar el archivo).
  private buildLayoutContent(data: string, lineStart: number): string | null {
    const lines = data.split("\n");
    const range = this.blockRange(lines, lineStart);
    if (!range) return null;
    {
      const [open, close] = range;
      const body = lines
        .slice(open + 1, close)
        .filter((l) => !/^\s*\/\/\s*@(pos|view|size|edge)\b/.test(l));
      // solo persiste posición de tablas que el usuario movió (las demás
      // siguen con auto-layout); la vista siempre se persiste.
      const posLines = this.model.tables
        .filter((t) => this.pos[t.name] && this.movedTables.has(t.name))
        .map((t) => {
          // posiciones ORIGINALES (this.pos): la disposición compacta del modo
          // enfoque es transitoria y no debe persistirse.
          const p = this.pos[t.name];
          return `// @pos ${t.name} ${Math.round(p.x)} ${Math.round(p.y)}`;
        });
      const viewLine = `// @view ${Math.round(this.view.x)} ${Math.round(
        this.view.y
      )} ${this.view.k.toFixed(3)}`;
      // tamaño solo si el usuario lo fijó (px inline); ancho 100% no se persiste.
      const sw = this.readPx(this.hostEl?.style.width);
      const sh = this.readPx(this.hostEl?.style.height);
      const sizeLines =
        Number.isFinite(sw) && Number.isFinite(sh)
          ? [`// @size ${sw} ${sh}`]
          : [];
      // rutas de aristas editadas a mano (solo waypoints intermedios)
      const edgeLines = this.model.refs
        .map((r) => ({ r, key: this.edgeKey(r) }))
        .filter((x) => this.customEdges[x.key]?.length)
        // se guardan en frame actual (mapeados) para que coincidan con @pos; al
        // recargar el frame base se recaptura y el mapeo arranca en identidad.
        .map(({ r, key }) => {
          const pts = this.mappedInterior(r, key);
          return (
            `// @edge ${r.from} ${r.fromCol} ${r.to} ${r.toCol} ` +
            pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(" ")
          );
        });
      return [
        ...lines.slice(0, open + 1),
        ...body,
        ...posLines,
        ...edgeLines,
        viewLine,
        ...sizeLines,
        ...lines.slice(close),
      ].join("\n");
    }
  }


  // lee px inline explícitos; ignora "", "100%", "auto", etc.
  private readPx(v?: string): number {
    // acepta px fraccionarios (p.ej. "400.5px") y redondea: el navegador puede
    // fijar tamaños sub-pixel al redimensionar; si no, @size no se persistía y
    // la altura revertía al default en cada re-render.
    const m = /^(\d+(?:\.\d+)?)px$/.exec(v ?? "");
    return m ? Math.round(parseFloat(m[1])) : NaN;
  }

  // persiste el tamaño del lienzo cuando el usuario lo redimensiona (handle CSS).
  private bindResize(host: HTMLElement) {
    const ro = new ResizeObserver(() => {
      const w = this.readPx(host.style.width);
      const h = this.readPx(host.style.height);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return; // sin px inline aún
      const key = `${w} ${h}`;
      if (key === this.lastSize) return; // sin cambio real → evita bucle/carga
      this.lastSize = key;
      this.scheduleSaveLayout();
    });
    ro.observe(host);
    this.register(() => ro.disconnect());
  }

  private bindPanZoom(host: HTMLElement) {
    let panning = false,
      psx = 0,
      psy = 0,
      pvx = 0,
      pvy = 0,
      panned = false;
    this.registerDomEvent(host, "pointerdown", (e: PointerEvent) => {
      const tgt = e.target as Element;
      // los nodos con layout desbloqueado detienen su propio pointerdown (drags);
      // los bloqueados lo dejan pasar aquí para que el izdo haga pan. Si el
      // pointerdown llega aquí sobre un nodo, es pan válido.
      // clic izquierdo sobre una arista: pan normal (dcho/medio lo gestiona la
      // propia arista). Los handles ya no existen (edición de rutas retirada).
      if (tgt.closest(".dbml-edge-hit")) {
        if (tgt.closest(".dbml-edge-handle") || e.button !== 0) return;
      }
      // el panel de referencias, el dropdown de tablas, el menú de zoom y el
      // toolbar no inician panning ni salen de foco
      if (
        tgt.closest(".dbml-refpanel") ||
        tgt.closest(".dbml-erd-toolbar") ||
        tgt.closest(".dbml-dd") ||
        tgt.closest(".dbml-zoom-menu")
      )
        return;
      // botón medio sobre el vacío: alterna el modo enfoque (las tablas/badges/
      // aristas detienen su propio pointerdown y gestionan su clic medio).
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFocusMode();
        return;
      }
      // clic en vacío: solo pan. NO sale del modo enfoque (hay que salir con
      // Esc o retirando las tablas del enfoque).
      panned = false;
      panning = true;
      host.addClass("panning");
      psx = e.clientX;
      psy = e.clientY;
      pvx = this.view.x;
      pvy = this.view.y;
    });
    this.registerDomEvent(activeWindow, "pointermove", (e: PointerEvent) => {
      if (!panning) return;
      if (Math.hypot(e.clientX - psx, e.clientY - psy) > 4) panned = true;
      this.view.x = pvx + (e.clientX - psx);
      this.view.y = pvy + (e.clientY - psy);
      this.applyView();
    });
    this.registerDomEvent(activeWindow, "pointerup", () => {
      if (!panning) return;
      panning = false;
      host.removeClass("panning");
      panned = false;
      this.scheduleSaveLayout();
    });
    this.registerDomEvent(host, "wheel", (e: WheelEvent) => {
      // el ráfaga de zoom no debe comerse el scroll de las listas internas:
      // el dropdown de tablas y el panel de referencias tienen su propio
      // desplazamiento y no deben disparar zoom ni bloquearse.
      const tgt = e.target as Element | null;
      if (tgt?.closest?.(".dbml-dd, .dbml-refpanel, .dbml-zoom-menu")) return;
      e.preventDefault();
      const r = host.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      // zoom con tope: 25%–400% (el anclaje al cursor usa la fracción efectiva)
      const k2 = Math.max(
        Diagram.MIN_ZOOM,
        Math.min(Diagram.MAX_ZOOM, this.view.k * (e.deltaY < 0 ? 1.12 : 0.89))
      );
      const f = k2 / this.view.k;
      this.view.x = mx - (mx - this.view.x) * f;
      this.view.y = my - (my - this.view.y) * f;
      this.view.k = k2;
      this.applyView();
      this.redrawHandles();
      this.scheduleSaveLayout();
    });
  }

  private zoom(f: number) {
    this.view.k = Math.max(
      Diagram.MIN_ZOOM,
      Math.min(Diagram.MAX_ZOOM, this.view.k * f)
    );
    this.applyView();
    this.redrawHandles();
    this.scheduleSaveLayout();
  }

  // ---- límites de la cámara ----
  // caja envolvente del contenido que se está mostrando (normal o modo enfoque).
  private contentBounds():
    | { minX: number; minY: number; maxX: number; maxY: number }
    | null {
    let minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    let any = false;
    for (const t of this.visibleTables()) {
      const P = this.px(t.name);
      if (!P) continue;
      any = true;
      const w = P.w || NODE_W;
      const h = P.h || HEAD_H + t.cols.length * ROW_H;
      minX = Math.min(minX, P.x);
      minY = Math.min(minY, P.y);
      maxX = Math.max(maxX, P.x + w);
      maxY = Math.max(maxY, P.y + h);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

// impide arrastrar el lienzo "hasta el infinito": al arrastrar hacia un lado
// solo se permite ver un "vacío" de hasta ~30% del viewport por ese eje (suelo
// de KEEP_VISIBLE px cuando el diagrama es pequeño); nunca se pierde el ERD.
  private clampView() {
    const b = this.contentBounds();
    if (!b) return;
    const r = this.svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const k = this.view.k;
    this.clampAxis("x", r.width / k, b.minX, b.maxX);
    this.clampAxis("y", r.height / k, b.minY, b.maxY);
  }

  // encuadra el borde de inicio del viewport (v0 = -view.{x|y}/vw) en [lo, hi]:
  //  - rango 30%: deja como máximo un vacío de ~30% del viewport por ese lado
  //    (lo = cMin - E, hi = cMax - vw + E);
  //  - si el diagrama es tan pequeño que ese rango se invierte, se cae al suelo
  //    "mantener visible": siempre queda al menos KEEP_VISIBLE px de contenido;
  //  - con un contenido más ancho que el viewport no hay vacío y no se toca nada.
  private clampAxis(
    axis: "x" | "y",
    vw: number,
    cMin: number,
    cMax: number
  ) {
    const E = Math.max(Diagram.MAX_EMPTY * vw, Diagram.KEEP_VISIBLE);
    let lo = cMin - E;
    let hi = cMax - vw + E;
    if (hi < lo) {
      // diagrama pequeño en un viewport grande: usar el suelo de visibilidad
      lo = cMin - vw + Diagram.KEEP_VISIBLE;
      hi = cMax - Diagram.KEEP_VISIBLE;
    }
    if (hi < lo) return; // contenido más ancho que el viewport: no hay vacío
    const v0 = axis === "x" ? -this.view.x / vw : -this.view.y / vw;
    const c0 = Math.min(Math.max(v0, lo), hi);
    if (axis === "x") this.view.x = -c0 * vw;
    else this.view.y = -c0 * vw;
  }

  private applyView() {
    // todas las mutaciones de cámara pasan por aquí: se comprueban los límites
    // de arrastre (deja por lo menos KEEP_VISIBLE px de tabla en el marco).
    this.clampView();
    this.vp.setAttribute(
      "transform",
      `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`
    );
    // porcentaje de zoom = escala de la letra (k*100 % del tamaño natural)
    if (this.zoomPct) this.zoomPct.textContent = Math.round(this.view.k * 100) + "%";
  }
  // vista actual (pan/zoom), para conservarla al re-renderizar en la ventana.
  getView() {
    return { x: this.view.x, y: this.view.y, k: this.view.k };
  }
  // consulta pública del diagrama (la ventana la usa antes de revelar).
  hasTable(name: string) {
    return !!this.pos[name];
  }
  // subraya en vivo la fila de columna editada sobre la tabla vigilada, sin
  // re-renderizar todo el SVG (table=null o idx=null borran el marcado).
  markLiveRow(table: string | null, idx: number | null) {
    const prev = this.liveRowEl;
    if (prev) {
      prev.classList.remove("dbml-row-live");
      this.liveRowEl = undefined;
    }
    this.liveRow = null;
    if (!table || idx === null || !this.pos[table]) return;
    this.liveRow = { table, idx };
    const node = this.nodeLayer.querySelector(
      `g[data-table="${CSS.escape(table)}"] rect[data-col="${idx}"]`
    );
    if (node) {
      node.classList.add("dbml-row-live");
      this.liveRowEl = node as SVGRectElement;
    }
  }
  // true mientras el diagrama está en modo enfoque/exploración.
  get exploring() {
    return !!this.focus && this.focus.size > 0;
  }
  // re-encuadra todo el diagrama (sin persistir): usado por la ventana al
  // cambiar de sistema de layout.
  refit() {
    this.fit(false);
  }
  private fit(persist = false) {
    const r = this.svg.getBoundingClientRect();
    if (r.width === 0) return;
    let minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    // encuadra solo lo visible: si hay modo enfoque, solo las tablas enfocadas
    for (const t of this.visibleTables()) {
      const P = this.px(t.name);
      if (!P) continue;
      minX = Math.min(minX, P.x);
      minY = Math.min(minY, P.y);
      maxX = Math.max(maxX, P.x + (P.w || NODE_W));
      maxY = Math.max(maxY, P.y + (P.h || HEAD_H + t.cols.length * ROW_H));
    }
    const pad = 40;
    const k = Math.min(
      (r.width - pad * 2) / (maxX - minX),
      (r.height - pad * 2) / (maxY - minY),
      1.4
    );
    this.view.k = isFinite(k) && k > 0 ? k : 1;
    this.view.x =
      pad - minX * this.view.k +
      (r.width - pad * 2 - (maxX - minX) * this.view.k) / 2;
    this.view.y = pad - minY * this.view.k;
    this.applyView();
    if (persist) this.scheduleSaveLayout();
  }
}

// Ventana/overlay a pantalla completa con el ERD a la izquierda y un editor
// DBML conmutable a la derecha (previsualización en vivo + guardar en la nota).
// Pieza bajo el cursor del editor, según el PATRÓN inverso por línea:
// clase (palabra tras "Table") / propiedad (primera palabra) / su tipo.
type CaretHit = {
  table: string;
  colIdx: number | null;
  colName: string | null;
  isClassDecl: boolean;
  inType: boolean;
  type: string | null;
};
class ErdWindowModal extends Modal {
  private plugin: DbmlErdPlugin;
  private clean: string;
  private file: TFile;
  private lineStart: number;
  private diagram?: Diagram;
  private drawHost?: HTMLElement;
  private codePanel?: HTMLElement;
  private codeBtn?: HTMLButtonElement;
  // miga de pan: indica (tabla · columna) dónde está el cursor del editor.
  private caretCrumb?: HTMLElement;
  private onCaretCleanup?: () => void;
  private splitEl?: HTMLElement;
  private editor?: HTMLTextAreaElement;
  private codeOpen = true;
  private previewTimer?: number;
  private previewToken = 0;
  private view?: { x: number; y: number; k: number };
  // sistema de layout activo en la ventana (se persiste como `// @layout`).
  private layoutKind: LayoutKind;
  // layout bloqueado (se persiste como `// @layoutLocked`): impide arrastrar.
  private layoutLocked: boolean;
  private lockBtn?: HTMLButtonElement;
  // última tabla revelada en vivo (cursor/seek) para reaplicarla al re-render.
  private lastReveal: string | null = null;
  // último modelo parseado (para resolver la columna bajo el cursor).
  private model?: Model;
  // al cambiar de layout se re-encuadra el diagrama completo tras el render.
  private refitNext = false;

  // vista del código fuente y elemento del bloque HTML de origen: se pasan al
  // Diagram de la ventana para que los arrastres persistan el layout @pos/@view
  // en la nota real (misma vía que usa el diagrama incrustado).
  private ctx: MarkdownPostProcessorContext | undefined;
  private blockEl: HTMLElement | undefined;

  constructor(
    app: App,
    plugin: DbmlErdPlugin,
    source: string,
    ref: {
      file: TFile;
      lineStart: number;
      ctx?: MarkdownPostProcessorContext;
      blockEl?: HTMLElement;
    }
  ) {
    super(app);
    this.plugin = plugin;
    this.file = ref.file;
    this.lineStart = ref.lineStart;
    this.ctx = ref.ctx;
    this.blockEl = ref.blockEl;
    this.layoutKind =
      parseLayout(source) ??
      this.plugin.settings.layout ??
      DEFAULT_SETTINGS.layout;
    this.layoutLocked = parseLayoutLocked(source);
    // el editor muestra el DBML "limpio": sin las anotaciones @pos/@view/@size/
    // @edge/@layout/@layoutLocked que gestiona el plugin (se reinyectan al guardar).
    const lines = source.split("\n");
    const isAnnot = (l: string) =>
      /^\s*\/\/\s*@(pos|view|size|edge|layout|layoutLocked)\b/.test(l);
    this.clean = lines.filter((l) => !isAnnot(l)).join("\n").replace(/\n+$/, "");
  }

  onOpen() {
    this.containerEl.addClass("erd-window-container");
    this.modalEl.addClass("erd-window");
    this.contentEl.addClass("erd-window-content");
    // el botón ✕ del modal (esquina sup. dcha) sobra: ya hay botón "Cerrar".
    this.modalEl.querySelector(".modal-close-button")?.remove();

    const head = this.contentEl.createDiv({ cls: "erd-window-head" });
    head.createSpan({ cls: "erd-window-title", text: t("windowTitle") });

    // desplegable del sistema de layout (se persiste al guardar como @layout)
    const layoutLabel = head.createSpan({
      cls: "erd-window-layout-label",
      text: t("layout"),
    });
    const layoutSel = head.createEl("select", {
      cls: "erd-window-layout",
    }) as HTMLSelectElement;
    for (const k of LAYOUT_KINDS) {
      const opt = layoutSel.createEl("option", { value: k, text: t(k) });
      layoutSel.append(opt);
    }
    layoutSel.value = this.layoutKind;
    layoutSel.addEventListener("change", () => {
      this.layoutKind = layoutSel.value as LayoutKind;
      // el cambio de sistema re-flota todo el diagrama desde cero
      this.lastReveal = null;
      this.view = undefined;
      this.refitNext = true;
      void this.preview();
    });
    layoutLabel.addEventListener("click", () => layoutSel.showPicker?.());

    // candado del layout (se persiste al guardar como `// @layoutLocked`)
    const lockBtn = head.createEl("button", {
      cls: "erd-window-btn erd-window-lock",
      text: this.layoutLocked ? "🔒" : "🔓",
    });
    this.lockBtn = lockBtn;
    lockBtn.title = this.layoutLocked ? t("lockLayout") : t("unlockLayout");
    if (this.layoutLocked) lockBtn.classList.add("is-active");
    lockBtn.addEventListener("click", () => {
      this.layoutLocked = !this.layoutLocked;
      lockBtn.textContent = this.layoutLocked ? "🔒" : "🔓";
      lockBtn.title = this.layoutLocked ? t("lockLayout") : t("unlockLayout");
      lockBtn.classList.toggle("is-active", this.layoutLocked);
      this.diagram?.setLayoutLocked(this.layoutLocked);
    });

    const codeBtn = head.createEl("button", { text: t("windowCode") });
    codeBtn.classList.add("erd-window-btn", "is-active");
    this.codeBtn = codeBtn;
    codeBtn.addEventListener("click", () => this.setCodeOpen(!this.codeOpen));

    const saveBtn = head.createEl("button", { text: t("windowSave") });
    saveBtn.classList.add("erd-window-btn");
    saveBtn.addEventListener("click", () => void this.save());

    const copyBtn = head.createEl("button", { text: t("windowCopy") });
    copyBtn.classList.add("erd-window-btn");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.editor?.value ?? "").then(
        () => new Notice(t("windowCopied")),
        () => new Notice(t("windowCopyError"))
      );
    });

    const exitBtn = head.createEl("button", { text: t("windowExit") });
    exitBtn.classList.add("erd-window-btn", "erd-window-exit");
    exitBtn.addEventListener("click", () => this.close());

    const body = this.contentEl.createDiv({ cls: "erd-window-body" });
    this.drawHost = body.createDiv({ cls: "erd-window-draw" });
    const split = body.createDiv({ cls: "erd-window-split" });
    const code = body.createDiv({ cls: "erd-window-code" });
    this.codePanel = code;
    // miga de pan SOBRE el editor (tabla · columna bajo el cursor): debe ir
    // antes que el textarea para quedar arriba en el panel flex-columna.
    const crumb = code.createDiv({ cls: "erd-window-crumb" });
    crumb.textContent = t("crumbIdle");
    this.caretCrumb = crumb;
    const ta = code.createEl("textarea", { cls: "erd-window-editor" });
    ta.value = this.clean;
    ta.spellcheck = false;
    ta.wrap = "off";
    this.editor = ta;
    ta.addEventListener("input", () => {
      this.schedulePreview();
      this.updateLiveReveal();
    });
    ta.addEventListener("click", () => this.updateLiveReveal());
    ta.addEventListener("keyup", () => this.updateLiveReveal());
    // cualquier movimiento del cursor (clic, flechas, etc.) actualiza la miga
    // de pan y el subrayado de columna, sin necesidad de editar. Se escucha en
    // el documento Y en el propio textarea (algunos navegadores no propagan
    // selectionchange de elementos input al documento).
    const onCaret = () => this.updateLiveReveal();
    this.onCaretCleanup = () => {
      activeDocument.removeEventListener("selectionchange", onCaret);
      ta.removeEventListener("selectionchange", onCaret);
    };
    activeDocument.addEventListener("selectionchange", onCaret);
    ta.addEventListener("selectionchange", onCaret);
    this.splitEl = split;
    this.initSplit(split, code, body);

    void this.renderDiagram(this.drawHost, this.clean);

    this.containerEl.requestFullscreen?.().catch(() => {});
  }

  private setCodeOpen(open: boolean) {
    this.codeOpen = open;
    this.codeBtn?.classList.toggle("is-active", open);
    this.codePanel?.toggleClass("hidden", !open);
    this.splitEl?.toggleClass("hidden", !open);
  }

  // Estructura de una línea de propiedad DBML:
  //   "  nombre TIPO [ attr1, nota: '...' ]"
  // Devuelve los cuatro componentes con sus posiciones (relativas a la línea):
  // el NOMBRE (1ª palabra delimitada por espacios), el TIPO (desde la 1ª
  // palabra tras el nombre hasta la última palabra que no sea espacio, antes de
  // " [" o del final de línea) y el CONTENIDO dentro de los corchetes grandes
  // "[...]" (p. ej. notas y restricciones).
  private parsePropLine(line: string): {
    name: string;
    nameStart: number;
    nameEnd: number;
    type: string;
    typeStart: number;
    typeEnd: number;
    attrs: string;
    attrsStart: number;
    attrsEnd: number;
  } | null {
    const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
    const nm = /("?)([^"'\s]+)\1/.exec(line.slice(lead));
    if (!nm) return null;
    const name = nm[2];
    const nameStart = lead + nm.index;
    const nameEnd = nameStart + name.length;
    const rest = line.slice(lead + nm.index + nm[0].length);
    // TIPO: primera palabra tras el nombre → última antes de " [" o del EOL.
    const tt = /^[ \t]*(\S(?:[^\[]*?\S)?)[ \t]*(?:\[|$)/.exec(rest);
    const type = tt ? tt[1] : "";
    const typeStart = tt ? nameEnd + tt[0].indexOf(tt[1]) : nameEnd;
    const typeEnd = typeStart + type.length;
    // NOTA/atributos: lo que hay dentro de los corchetes grandes.
    const aa = /^[ \t]*(\S(?:[^\[]*?\S)?)[ \t]*\[[ \t]*(.*?)[ \t]*\]/.exec(rest);
    const attrs = aa ? aa[2] : "";
    const attrsStart = aa ? nameEnd + aa[0].indexOf(aa[2]) : nameEnd;
    const attrsEnd = attrsStart + attrs.length;
    return { name, nameStart, nameEnd, type, typeStart, typeEnd, attrs, attrsStart, attrsEnd };
  }

  // Selección para saltar a la columna `col` de `table`: busca la línea de la
  // propiedad DENTRO del bloque "Table … {" … "}" y devuelve el rango según la
  // pieza pedida: nombre (1ª palabra), tipo (hasta la última palabra antes de
  // " [" o del EOL) o ambos. PATRÓN clase: la palabra que sigue a "Table".
  private locPropLine(
    value: string,
    table: string,
    col: string,
    part: "class" | "name" | "type" = "name"
  ): { start: number; end: number } {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tableRe = new RegExp(
      `^[ \\t]*Table[ \\t]+["']?${esc(table)}["']?(?=[ \\t]*(?:\\[[^\\r\\n{}]*\\])?[ \\t]*\\{)`,
      "m"
    );
    const tm = tableRe.exec(value);
    const nameStart = tm
      ? tm.index + tm[0].indexOf(table)
      : value.indexOf(table);
    if (tm) {
      let depth = 0;
      let close = value.length;
      for (let i = tm.index; i < value.length; i++) {
        const ch = value[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      const block = value.slice(tm.index, close);
      const lineRe = /[^\r\n]+/g;
      let lm: RegExpExecArray | null;
      while ((lm = lineRe.exec(block))) {
        const p = this.parsePropLine(lm[0]);
        if (!p || p.name !== col) continue;
        const lineBase = tm.index + lm.index;
        if (part === "type" && p.type) {
          // PATRÓN tipo: solo el tipo de la propiedad
          return {
            start: lineBase + p.typeStart,
            end: lineBase + p.typeEnd,
          };
        }
        if (part === "name" || !p.type) {
          // PATRÓN nombre: solo la primera palabra de la línea
          return {
            start: lineBase + p.nameStart,
            end: lineBase + p.nameEnd,
          };
        }
        // rango completo: nombre + tipo
        return {
          start: lineBase + p.nameStart,
          end: lineBase + p.typeEnd,
        };
      }
    }
    // no hallada: selecciona el nombre de la clase
    return { start: nameStart, end: nameStart + table.length };
  }

  // muestra el editor y lleva el foco a la tabla (col opcional) resaltándola.
  jumpTo(
    table: string,
    col: string | null,
    part: "class" | "name" | "type" = "class"
  ) {
    const ed = this.editor;
    if (!ed) return;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = ed.value;
    // PATRÓN tabla: "Table <nombre>" con ajustes tolerados entre el nombre y
    // la llave, p. ej. "Table Companies [headercolor: #607D8B] {".
    const tableRe = new RegExp(
      `^[ \\t]*Table[ \\t]+["']?${esc(table)}["']?(?=[ \\t]*(?:\\[[^\\r\\n{}]*\\])?[ \\t]*\\{)`,
      "m"
    );
    let index = -1;
    let selLen = table.length;
    const tm = tableRe.exec(value);
    if (tm) {
      const nameStart = tm.index + tm[0].indexOf(table);
      if (col) {
        const loc = this.locPropLine(value, table, col, part);
        index = loc.start;
        selLen = loc.end - loc.start;
      } else {
        // selección del nombre de la clase (la palabra tras "Table")
        index = nameStart;
        selLen = table.length;
      }
    } else {
      index = value.indexOf(table);
    }
    if (index < 0) return;
    this.setCodeOpen(true);
    ed.focus();
    ed.setSelectionRange(index, index + selLen);
    // revela la tabla buscada en el diagrama (revealTable sale del enfoque)
    this.lastReveal = table;
    const d = this.diagram;
    if (d && d.hasTable(table)) d.revealTable(table);
    this.updateLiveReveal(); // también subraya la columna saltada
    // desplazar la línea objetivo a ~1/3 de la altura visible
    const lh = parseFloat(getComputedStyle(ed).lineHeight) || 18;
    const line = ed.value.slice(0, index).split("\n").length - 1;
    ed.scrollTop = Math.max(0, line * lh - ed.clientHeight / 3);
  }

  private schedulePreview() {
    if (this.previewTimer) activeWindow.clearTimeout(this.previewTimer);
    this.previewTimer = activeWindow.setTimeout(() => void this.preview(), 400);
  }

  // reveal en vivo: la tabla cuyo bloque de código contiene el cursor se
  // concentra/resalta en el diagrama de la izquierda SIN entrar en modo
  // enfoque (el resto de tablas permanece visible). También actualiza la miga
  // de pan y el subrayado de columna con CADA movimiento del cursor.
  private updateLiveReveal() {
    const hit = this.tableAtCaret();
    const table = hit ? hit.table : null;
    const colIdx = hit ? hit.colIdx : null;
    this.updateCrumb(hit);
    const d = this.diagram;
    if (table && table !== this.lastReveal) {
      this.lastReveal = table;
      // revealTable ya sale del modo enfoque si hace falta
      if (d && d.hasTable(table)) d.revealTable(table);
    }
    // subraya la columna exacta del cursor en la tabla vigilada
    if (d && table && d.hasTable(table)) {
      d.markLiveRow(table, colIdx);
    } else {
      d?.markLiveRow(null, null);
    }
  }

  // miga de pan sobre el editor: muestra el resultado vivo del parseo inverso
// de la línea bajo el cursor: clase, "clase · propiedad" o "clase · prop · tipo".
private updateCrumb(hit: CaretHit | null) {
  if (!this.caretCrumb) return;
  if (!hit) {
    this.caretCrumb.textContent = t("crumbIdle");
    this.caretCrumb.removeAttribute("data-table");
    this.caretCrumb.removeAttribute("data-col");
    return;
  }
  const { table } = hit;
  const col = hit.colName;
  let text = table;
  if (col && !hit.isClassDecl) {
    text = hit.inType && hit.type ? `${table} · ${col} · ${hit.type}` : `${table} · ${col}`;
  }
  this.caretCrumb.textContent = text;
  this.caretCrumb.setAttribute("data-table", table);
  if (hit.colIdx !== null && hit.colIdx >= 0)
    this.caretCrumb.setAttribute("data-col", String(hit.colIdx));
  else this.caretCrumb.removeAttribute("data-col");
}

  // tablas/columnas vivos del cursor, por PARSE INVERSO de la línea:
//  - línea que empieza por "Table" → declaración de clase; el nombre es la
//    palabra que sigue a "Table" (PATRÓN clase).
//  - cualquier otra línea dentro de una clase → su primera palabra es el nombre
//    de la propiedad (PATRÓN propiedad); si el cursor cae sobre la parte del
//    TIPO, se devuelve también ese tipo (PATRÓN tipo).
private tableAtCaret(): CaretHit | null {
  const ed = this.editor;
  if (!ed) return null;
  const value = ed.value;
  const sel = ed.selectionStart ?? 0;
  if (sel < 0 || sel > value.length) return null;
  const lineOf = (idx: number) => value.slice(0, idx).split("\n").length;
  const caretLine = lineOf(sel);
  // línea completa donde está el cursor y su posición relativa
  const lineStart = value.lastIndexOf("\n", sel - 1) + 1;
  const lineEndIdx = value.indexOf("\n", sel);
  const line = value.slice(
    lineStart,
    lineEndIdx < 0 ? value.length : lineEndIdx
  );
  const caretRel = sel - lineStart;

  // PATRÓN clase: línea con "Table <nombre>" (los ajustes hasta "{" se toleran)
  const tbl = /^[ \t]*Table[ \t]+("?)([^"'\s]+)\1/.exec(line);
  const isClassDecl = !!tbl;
  const lineFirst = /^[ \t]*("?)([^"'\s]+)\1/.exec(line);
  // qué clase contiene la línea del cursor (bloque { ... } más cercano)
  const re = /^[ \t]*Table[ \t]+("?)([^"'\s]+)\1(?=[ \t]*(?:\[[^\r\n{}]*\])?[ \t]*\{)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const startLine = lineOf(m.index);
    if (startLine > caretLine) break;
    let depth = 0;
    let i = m.index;
    for (; i < value.length; i++) {
      const ch = value[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= value.length) continue; // bloque sin cerrar: se ignora
    if (caretLine <= lineOf(i)) {
      const t = this.model?.tables.find((x) => x.name === m![2]);
      if (!t) return null;
      let colIdx: number | null = null;
      let colName: string | null = null;
      let inType = false;
      let type: string | null = null;
      if (isClassDecl) {
        colName = tbl ? tbl[2] : lineFirst ? lineFirst[2] : null;
      } else if (lineFirst) {
        // PATRÓN propiedad: primera palabra de la línea
        colName = lineFirst[2];
        const idx = t.cols.findIndex((c) => c.name === colName);
        if (idx >= 0) colIdx = idx;
        // PATRÓN tipo: el cursor cae dentro de la parte del tipo
        const p = this.parsePropLine(line);
        if (p && p.name === colName && p.type) {
          if (caretRel >= p.typeStart && caretRel <= p.typeEnd) {
            inType = true;
            type = p.type;
          }
        }
      }
      return { table: m[2], colIdx, colName, isClassDecl, inType, type };
    }
  }
  return null;
}

  private async preview() {
    if (!this.drawHost || !this.editor) return;
    // conserva el encuadre (pan/zoom) entre re-render mientras se escribe
    this.view = this.diagram?.getView() ?? this.view;
    this.diagram?.unload();
    this.diagram = undefined;
    this.drawHost.empty();
    const token = ++this.previewToken;
    await this.renderDiagram(
      this.drawHost,
      this.editor.value,
      this.view,
      token
    );
  }

  private async renderDiagram(
    host: HTMLElement,
    src: string,
    view?: { x: number; y: number; k: number },
    token?: number
  ) {
    const stale = () => token !== undefined && token !== this.previewToken;
    try {
      const model = parseDBML(src);
      if (stale()) return;
      this.model = model;
      if (!model.tables.length) {
        host.createDiv({ cls: "dbml-erd-wrap", text: t("noTables") });
        return;
      }
      const layout = await this.plugin.layoutFor(src, model, this.layoutKind);
      if (stale()) return;
      // copia defensiva: el Diagram mueve/edita nodos y no queremos tocar la
      // caché compartida de layouts.
      const nodes: LayoutResult["nodes"] = {};
      for (const [k, v] of Object.entries(layout.nodes)) nodes[k] = { ...v };
      this.diagram = new Diagram(
        host,
        model,
        { nodes, edges: layout.edges, routes: layout.routes },
        {
          plugin: this.plugin,
          window: true,
          ctx: this.ctx,
          el: this.blockEl,
          savedPos: parsePositions(src),
          view: view ?? parseView(src) ?? undefined,
          size: parseSize(src) ?? undefined,
          savedEdges: parseEdges(src),
          layout: this.layoutKind,
          layoutLocked: this.layoutLocked,
          focus: parseFocusOn(src) ?? undefined,
          onJump: (table, col, part) => this.jumpTo(table, col, part),
        }
      );
      // tras un re-render (cambio de layout o edición) se mantiene la última
      // tabla revelada en vivo
      if (
        this.lastReveal &&
        this.diagram &&
        !this.diagram.exploring &&
        this.diagram.hasTable(this.lastReveal)
      ) {
        this.diagram.revealTable(this.lastReveal);
      }
      if (this.refitNext) {
        this.refitNext = false;
        this.diagram?.refit();
      }
    } catch (e) {
      if (stale()) return;
      host.createDiv({
        cls: "dbml-erd-wrap",
        text: t("layoutError", { msg: e instanceof Error ? e.message : String(e) }),
      });
    }
  }

  // escribe el código editado de vuelta en el bloque, conservando las
  // anotaciones del plugin (@pos/@view/@size/@edge/@layout) del archivo.
  private isAnnotLine(l: string) {
    return /^\s*\/\/\s*@(pos|view|size|edge|layout|layoutLocked|focusOn)\b/.test(l);
  }
  private escRe(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async save() {
    if (!this.editor) return;
    const data = await this.plugin.app.vault.read(this.file);
    const lines = data.split("\n");
    const range = this.blockRange(lines, this.lineStart);
    if (!range) {
      new Notice(t("windowSaveError"));
      return;
    }
    const oldBody = lines.slice(range[0] + 1, range[1]).join("\n");
    const newBody = this.editor.value.replace(/\n+$/, "");
    // si se renombró una tabla, se ofrece reescribir también sus referencias
    let rename: { old: string; new: string } | null = null;
    try {
      rename = this.detectRename(oldBody, newBody);
    } catch {
      /* parseo roto en edición → se guarda tal cual */
    }
    if (rename) {
      const n = this.countRefs(newBody, rename.old);
      new ConfirmModal(
        this.app,
        t("renameTitle"),
        t("renameBody", {
          old: rename.old,
          new: rename.new,
          n: String(n),
        }),
        t("renameApply"),
        () => void this.writeBack(data, range, rename)
      ).open();
      return;
    }
    await this.writeBack(data, range, null);
  }

  // una tabla renombrada = exactamente una desaparecida y una nueva con las
  // MISMAS columnas/tipos; si cuadra, devuelve el mapeo old→new.
  private detectRename(
    oldSrc: string,
    newSrc: string
  ): { old: string; new: string } | null {
    const a = parseDBML(oldSrc);
    const b = parseDBML(newSrc);
    const namesA = new Set(a.tables.map((x) => x.name));
    const namesB = new Set(b.tables.map((x) => x.name));
    const removed = a.tables.filter((x) => !namesB.has(x.name));
    const added = b.tables.filter((x) => !namesA.has(x.name));
    if (removed.length !== 1 || added.length !== 1) return null;
    const sig = (t: { cols: { name: string; type: string }[] }) =>
      t.cols.map((c) => `${c.name}:${c.type}`).join("|");
    if (sig(removed[0]) !== sig(added[0])) return null;
    return { old: removed[0].name, new: added[0].name };
  }

  private countRefs(src: string, tableName: string): number {
    const re = new RegExp(`\\b${this.escRe(tableName)}\\b`, "g");
    return src
      .split("\n")
      .filter((l) => /^\s*Ref:/i.test(l) && re.test(l)).length;
  }

  // reescribe el nombre de tabla en Ref/pos/edge (no toca otros tokens).
  private renameRefLines(line: string, oldName: string, newName: string): string {
    if (/^\s*Ref:/i.test(line) || /^\s*\/\/\s*@(pos|edge)\b/.test(line)) {
      return line.replace(
        new RegExp(`\\b${this.escRe(oldName)}\\b`, "g"),
        newName
      );
    }
    return line;
  }

  private async writeBack(
    data: string,
    range: [number, number],
    rename: { old: string; new: string } | null
  ) {
    if (!this.editor) return;
    const lines = data.split("\n");
    const [open, close] = range;
    let annots: string[] = lines
      .slice(open + 1, close)
      .filter((l) => this.isAnnotLine(l));
    // la línea `@layout` se mantiene actualizada con el desplegable (una sola)
    let layoutWritten = false;
    annots = annots.map((l) => {
      if (/^\s*\/\/\s*@layout\b/.test(l)) {
        layoutWritten = true;
        return `// @layout ${this.layoutKind}`;
      }
      return l;
    });
    if (!layoutWritten) annots.unshift(layoutLine(this.layoutKind));
    // la línea `@layoutLocked` refleja el estado del candado (siempre escrita:
    // ausencia = bloqueado por defecto; `false` persiste el desbloqueo)
    let lockWritten = false;
    annots = annots.map((l) => {
      if (/^\s*\/\/\s*@layoutLocked\b/.test(l)) {
        lockWritten = true;
        return layoutLockLine(this.layoutLocked);
      }
      return l;
    });
    if (!lockWritten) annots.unshift(layoutLockLine(this.layoutLocked));
    // la línea `@focusOn` refleja el foco del diagrama montado (o se retira).
    let focusWritten = false;
    annots = annots.map((l) => {
      if (/^\s*\/\/\s*@focusOn\b/.test(l)) {
        focusWritten = true;
        const names = this.diagram ? this.diagram.getFocusedTables() : [];
        return names.length ? focusOnLine(names) : "";
      }
      return l;
    });
    annots = annots.filter((l) => l !== "");
    if (!focusWritten) {
      const names = this.diagram ? this.diagram.getFocusedTables() : [];
      if (names.length) annots.unshift(focusOnLine(names));
    }
    let body = this.editor.value.replace(/\n+$/, "").split("\n");
    if (rename) {
      // también se renombra la anotación @pos (@pos Old …) para conservar la
      // posición (evita que la tabla renombrada salte al auto-layout).
      body = body.map((l) => this.renameRefLines(l, rename.old, rename.new));
      annots = annots.map((l) => this.renameRefLines(l, rename.old, rename.new));
    }
    const content = [
      ...lines.slice(0, open + 1),
      ...body,
      ...annots,
      lines[close],
      ...lines.slice(close + 1),
    ].join("\n");
    await this.plugin.app.vault.process(this.file, () => content);
    new Notice(t("windowSaved"));
  }

  private blockRange(
    lines: string[],
    lineStart: number
  ): [number, number] | null {
    const isFence = (l: string | undefined) => !!l && /^\s*(```|~~~)/.test(l);
    if (!isFence(lines[lineStart])) return null;
    for (let i = lineStart + 1; i < lines.length; i++) {
      if (isFence(lines[i])) return [lineStart, i];
    }
    return null;
  }

  // separador arrastrable entre el diagrama y el editor de código
  private initSplit(split: HTMLElement, code: HTMLElement, body: HTMLElement) {
    let dragging = false;
    split.addEventListener("pointerdown", (ev: PointerEvent) => {
      dragging = true;
      try {
        split.setPointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
      ev.preventDefault();
    });
    split.addEventListener("pointermove", (ev: PointerEvent) => {
      if (!dragging) return;
      const r = body.getBoundingClientRect();
      const w = Math.min(Math.max(r.right - ev.clientX, 240), r.width - 240);
      code.style.width = `${w}px`;
      code.style.maxWidth = `${w}px`;
    });
    const stop = (ev: PointerEvent) => {
      dragging = false;
      try {
        split.releasePointerCapture(ev.pointerId);
      } catch {
        /* noop */
      }
    };
    split.addEventListener("pointerup", stop);
    split.addEventListener("pointercancel", stop);
  }

  onClose() {
    if (this.previewTimer) activeWindow.clearTimeout(this.previewTimer);
    this.diagram?.unload();
    this.diagram = undefined;
    this.onCaretCleanup?.();
    this.onCaretCleanup = undefined;
    if (activeDocument.fullscreenElement === this.containerEl)
      activeDocument.exitFullscreen?.().catch(() => {});
    this.contentEl.empty();
  }
}

// Modal mínimo con un campo de texto (Enter guarda, Esc cancela).
class ConfirmModal extends Modal {
  private titleText: string;
  private bodyText: string;
  private confirmText: string;
  private onConfirm: () => void;
  constructor(
    app: App,
    titleText: string,
    bodyText: string,
    confirmText: string,
    onConfirm: () => void
  ) {
    super(app);
    this.titleText = titleText;
    this.bodyText = bodyText;
    this.confirmText = confirmText;
    this.onConfirm = onConfirm;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    contentEl.createEl("p", { text: this.bodyText });
    const bar = contentEl.createDiv({ cls: "dbml-edit-actions" });
    const ok = bar.createEl("button", { text: this.confirmText });
    ok.classList.add("mod-warning");
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
    const cancel = bar.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
    cancel.focus();
  }
  onClose() {
    this.contentEl.empty();
  }
}

class EditModal extends Modal {
  private titleText: string;
  private initial: string;
  private onSubmit: (v: string) => void;
  constructor(
    app: App,
    titleText: string,
    initial: string,
    onSubmit: (v: string) => void
  ) {
    super(app);
    this.titleText = titleText;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.titleText });
    const input = contentEl.createEl("input", { type: "text" });
    input.classList.add("dbml-edit-input");
    input.value = this.initial;
    input.focus();
    input.select();
    const submit = () => {
      const v = input.value.trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        this.close();
      }
    });
    const bar = contentEl.createDiv({ cls: "dbml-edit-actions" });
    const ok = bar.createEl("button", { text: t("save") });
    ok.classList.add("mod-cta");
    ok.onclick = submit;
    const cancel = bar.createEl("button", { text: t("cancel") });
    cancel.onclick = () => this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}

// Settings tab: language selector (English default). Changing it updates the
// active language for menus/dialogs/notices opened afterwards.
class DbmlErdSettingTab extends PluginSettingTab {
  private plugin: DbmlErdPlugin;
  constructor(app: App, plugin: DbmlErdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName(t("settingsLanguage"))
      .setDesc(t("settingsLanguageDesc"))
      .addDropdown((dd) => {
        for (const { value, label } of LANGS) dd.addOption(value, label);
        dd.setValue(this.plugin.settings.lang).onChange(async (v) => {
          this.plugin.settings.lang = v as Lang;
          await this.plugin.saveSettings();
          this.display(); // re-render the tab in the new language
        });
      });
    new Setting(containerEl)
      .setName(t("settingsLayout"))
      .setDesc(t("settingsLayoutDesc"))
      .addDropdown((dd) => {
        for (const k of LAYOUT_KINDS) dd.addOption(k, t(k));
        dd.setValue(this.plugin.settings.layout).onChange(async (v) => {
          this.plugin.settings.layout = v as LayoutKind;
          await this.plugin.saveSettings();
        });
      });
  }
}
