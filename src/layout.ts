// Layout: elkjs (layered / stress) para nodos y el router ortogonal propio del
// Diagram para las variantes no jerárquicas (radial/organic).
import type {
  ELK as ElkInstance,
  ElkNode,
  ElkPort,
  ElkExtendedEdge,
} from "elkjs/lib/elk-api";
import type { LayoutKind, Model } from "./parser";

export const ROW_H = 28;
export const HEAD_H = 36;
export const NODE_W = 216;

export interface Pt {
  x: number;
  y: number;
}
export interface NodePos {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EdgePath {
  pts: Pt[]; // polilínea ruteada (coords absolutas)
}
export interface LayoutResult {
  nodes: Record<string, NodePos>;
  edges: EdgePath[]; // mismo orden que model.refs
  // "elk" = las aristas vienen ruteadas por ELK (jerárquico);
  // "manhattan" = el Diagram las rutea con su router ortogonal de 90°.
  routes: "elk" | "manhattan";
}

// ELK (~1.6 MB) se carga perezosamente en el primer layout: el import()
// dinámico difiere la evaluación del motor al primer render en vez del
// arranque de Obsidian. La promesa compartida dedupe renders concurrentes.
let elkPromise: Promise<ElkInstance> | undefined;
function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import("elkjs/lib/elk.bundled.js").then(
      (m) => new m.default()
    );
  }
  return elkPromise;
}

export function tableHeight(colCount: number): number {
  return HEAD_H + colCount * ROW_H;
}
function colRowY(model: Model, table: string, col: string): number {
  const t = model.tables.find((t) => t.name === table);
  if (!t) return HEAD_H / 2;
  const i = t.cols.findIndex((c) => c.name === col);
  const idx = i < 0 ? 0 : i;
  return HEAD_H + idx * ROW_H + ROW_H / 2;
}

export async function computeLayout(
  model: Model,
  kind: LayoutKind = "layered-lr"
): Promise<LayoutResult> {
  // variantes no jerárquicas: solo posicionan nodos; las aristas las rutea el
  // propio Diagram de forma ortogonal (routes: "manhattan").
  if (kind === "radial") {
    return { nodes: radialNodes(model), edges: model.refs.map(() => ({ pts: [] })), routes: "manhattan" };
  }
  if (kind === "organic") {
    const nodes = await stressNodes(model);
    return { nodes, edges: model.refs.map(() => ({ pts: [] })), routes: "manhattan" };
  }

  const children: ElkNode[] = model.tables.map((t) => {
    const h = tableHeight(t.cols.length);
    const ports: ElkPort[] = [];
    model.refs.forEach((r, i) => {
      if (r.from === t.name) {
        const y = colRowY(model, t.name, r.fromCol);
        ports.push(port(`s${i}_e`, NODE_W, y, "EAST"));
        ports.push(port(`s${i}_w`, 0, y, "WEST"));
      }
      if (r.to === t.name) {
        const y = colRowY(model, t.name, r.toCol);
        ports.push(port(`t${i}_e`, NODE_W, y, "EAST"));
        ports.push(port(`t${i}_w`, 0, y, "WEST"));
      }
    });
    return {
      id: t.name,
      width: NODE_W,
      height: h,
      ports,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    };
  });

  // source desde EAST, target hacia WEST (caso jerárquico común)
  const edges: ElkExtendedEdge[] = model.refs.map((r, i) => ({
    id: "e" + i,
    sources: [`s${i}_e`],
    targets: [`t${i}_w`],
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": kind === "layered-tb" ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.spacing.nodeNode": "50",
      "elk.spacing.edgeNode": "25",
    },
    children,
    edges,
  };

  const res = await (await getElk()).layout(graph);
  const nodes: Record<string, NodePos> = {};
  for (const n of res.children ?? []) {
    nodes[n.id] = {
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: n.width ?? 0,
      h: n.height ?? 0,
    };
  }
  // Indexa por id de arista ('e'+i) en vez de confiar en el orden de salida
  // de ELK, que no está garantizado que coincida con el de entrada.
  const byId: Record<string, Pt[]> = {};
  for (const e of res.edges ?? []) {
    const ee = e as ElkExtendedEdge;
    const sec = ee.sections?.[0];
    byId[ee.id ?? ""] = sec
      ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]
      : [];
  }
  const edgePaths: EdgePath[] = model.refs.map((_, i) => ({
    pts: byId["e" + i] ?? [],
  }));
  return { nodes, edges: edgePaths, routes: "elk" };
}

function port(id: string, x: number, y: number, side: string): ElkPort {
  return {
    id,
    x,
    y,
    width: 1,
    height: 1,
    layoutOptions: { "elk.port.side": side },
  };
}

// Lay-out "radial"/circular determinista: tablas repartidas en un anillo ÚNICO
// alrededor del origen (orientación "esférica" compacta). El radio se calcula
// para que la cuerda entre centros consecutivos no solape los anchos; 1 tabla
// se centra y 2 se colocan a izquierda/derecha. El ELK "radial" nativo exige
// un grafo en árbol (los ERD son cíclicos), por eso es propio.
function radialNodes(model: Model): Record<string, NodePos> {
  const out: Record<string, NodePos> = {};
  const tables = model.tables;
  const n = tables.length;
  if (n === 0) return out;
  for (const t of tables) {
    out[t.name] = {
      x: 0,
      y: 0,
      w: NODE_W,
      h: tableHeight(t.cols.length),
    };
  }
  if (n === 1) return out;
  if (n === 2) {
    const gap = 120;
    const a = out[tables[0].name];
    const b = out[tables[1].name];
    a.x = 0;
    a.y = 0;
    b.x = a.w + gap;
    b.y = 0;
    return out;
  }
  // cuerda entre centros adyacentes ~ ancho de tabla + margen
  const chord = NODE_W + 70;
  const r = Math.max(200, chord / (2 * Math.sin(Math.PI / n)));
  const cx = 0,
    cy = 0;
  tables.forEach((t, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const p = out[t.name];
    p.x = cx + Math.cos(ang) * r - p.w / 2;
    p.y = cy + Math.sin(ang) * r - p.h / 2;
  });
  return out;
}

// Lay-out "organic" con ELK stress (apegometría basada en fuerzas; admite
// grafos cíclicos). Solo posiciones de nodos; las aristas se rutean luego.
async function stressNodes(model: Model): Promise<Record<string, NodePos>> {
  const children: ElkNode[] = model.tables.map((t) => ({
    id: t.name,
    width: NODE_W,
    height: tableHeight(t.cols.length),
  }));
  const elkEdges: ElkExtendedEdge[] = model.refs.map((r, i) => ({
    id: "e" + i,
    sources: [r.from],
    targets: [r.to],
  }));
  const res = await (
    await getElk()
  ).layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "stress",
      "elk.stress.desiredEdgeLength": "120",
    },
    children,
    edges: elkEdges,
  });
  const nodes: Record<string, NodePos> = {};
  for (const t of model.tables) {
    const n = (res.children ?? []).find((x) => x.id === t.name);
    nodes[t.name] = {
      x: n?.x ?? 0,
      y: n?.y ?? 0,
      w: NODE_W,
      h: tableHeight(t.cols.length),
    };
  }
  return nodes;
}
