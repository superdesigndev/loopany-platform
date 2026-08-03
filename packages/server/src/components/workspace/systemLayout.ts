import dagre from '@dagrejs/dagre'

import type { GraphEdge, GraphNode } from './api'

/**
 * THE SYSTEM GRAPH'S LAYOUT — deterministic, banded Dagre.
 *
 * Ported from the preserved reference demo (`data/graph-demo-r1/`) and
 * generalized over the projection's three node types. Two properties are worth
 * naming because they are what make the canvas trustworthy:
 *
 *  1. **Deterministic.** Same nodes and edges in ⇒ same coordinates out. No
 *     force simulation, no clock, no randomness — so a refetch that changes
 *     nothing does not reshuffle the picture under the reader's cursor, and this
 *     module is unit-testable as a pure function.
 *  2. **Banded.** `you` on top, loops in the middle, the unclaimed pool below.
 *     The bands encode the design's own claim: loops never wire to loops — they
 *     meet at the instance layer, so the interesting traffic is VERTICAL
 *     (a loop asks you; you answer a watcher; a loop produces into the pool; a
 *     steward adopts out of it).
 *
 * Within the loop band, connected components are laid out left-to-right with
 * Dagre and packed into rows, so an isolated loop never drags a lane open.
 */

export const NODE_WIDTH = 188
export const NODE_HEIGHT = 64
const MAX_ROW_WIDTH = 1400
const COMPONENT_GAP = 48
const ROW_GAP = 34
const BAND_GAP = 90
const MARGIN = 44

export const BAND_ORDER: GraphNode['type'][] = ['you', 'loop', 'pool']

export type Point = { x: number; y: number }

function connectedComponents(ids: string[], edges: GraphEdge[]): string[][] {
  const present = new Set(ids)
  const neighbors = new Map(ids.map((id) => [id, new Set<string>()]))
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue
    neighbors.get(edge.from)?.add(edge.to)
    neighbors.get(edge.to)?.add(edge.from)
  }
  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of ids) {
    if (seen.has(start)) continue
    const queue = [start]
    const component: string[] = []
    seen.add(start)
    while (queue.length) {
      const id = queue.shift()!
      component.push(id)
      for (const neighbor of neighbors.get(id) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    components.push(component.sort())
  }
  return components
}

function layoutComponent(ids: string[], edges: GraphEdge[]): { width: number; height: number; positions: Map<string, Point> } {
  if (ids.length === 1) return { width: NODE_WIDTH, height: NODE_HEIGHT, positions: new Map<string, Point>([[ids[0]!, { x: 0, y: 0 }]]) }
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', ranksep: 64, nodesep: 30, marginx: 0, marginy: 0, acyclicer: 'greedy', ranker: 'tight-tree' })
  for (const id of ids) graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  const present = new Set(ids)
  for (const edge of edges) if (present.has(edge.from) && present.has(edge.to) && edge.from !== edge.to) graph.setEdge(edge.from, edge.to)
  dagre.layout(graph)
  const placed = ids.map((id) => {
    const point = graph.node(id)
    return { id, x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 }
  })
  const minX = Math.min(...placed.map((p) => p.x))
  const minY = Math.min(...placed.map((p) => p.y))
  return {
    width: Math.max(...placed.map((p) => p.x - minX + NODE_WIDTH)),
    height: Math.max(...placed.map((p) => p.y - minY + NODE_HEIGHT)),
    positions: new Map(placed.map((p) => [p.id, { x: p.x - minX, y: p.y - minY }])),
  }
}

/** Nodes → coordinates. Pure: no DOM, no clock, no randomness. */
export function layoutSystem(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Point> {
  const positions = new Map<string, Point>()
  let bandTop = MARGIN
  for (const band of BAND_ORDER) {
    const bandNodes = nodes.filter((node) => node.type === band).sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id) || a.id.localeCompare(b.id))
    if (!bandNodes.length) continue
    const ids = bandNodes.map((node) => node.id)
    const inBand = edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to))
    const laid = connectedComponents(ids, inBand)
      // Bigger clusters first, then alphabetically — a stable, explainable order.
      .sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''))
      .map((component) => layoutComponent(component, inBand))

    let rowX = 0
    let rowY = 0
    let rowHeight = 0
    let bandHeight = 0
    for (const item of laid) {
      if (rowX > 0 && rowX + item.width > MAX_ROW_WIDTH) {
        rowY += rowHeight + ROW_GAP
        rowX = 0
        rowHeight = 0
      }
      for (const [id, point] of item.positions) positions.set(id, { x: MARGIN + rowX + point.x, y: bandTop + rowY + point.y })
      rowX += item.width + COMPONENT_GAP
      rowHeight = Math.max(rowHeight, item.height)
      bandHeight = Math.max(bandHeight, rowY + item.height)
    }
    bandTop += Math.max(NODE_HEIGHT, bandHeight) + BAND_GAP
  }
  // Anything unbanded (a node type this layout does not know) still lands
  // somewhere visible rather than stacking at the origin.
  for (const node of nodes) if (!positions.has(node.id)) positions.set(node.id, { x: MARGIN, y: bandTop })
  return positions
}

// ---- manual pins: drag to arrange, saved locally ----

export const LAYOUT_STORAGE_KEY = 'loopany-workspace-system-layout-v1'

export function readPins(storage: Pick<Storage, 'getItem'> | undefined): Record<string, Point> {
  try {
    const value = JSON.parse(storage?.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as Record<string, Point>
    return Object.fromEntries(Object.entries(value).filter(([, point]) => Number.isFinite(point?.x) && Number.isFinite(point?.y)))
  } catch {
    return {}
  }
}

export function writePin(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, id: string, point: Point | null): void {
  if (!storage) return
  const pins = readPins(storage)
  if (point) pins[id] = point
  else delete pins[id]
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(pins))
}
