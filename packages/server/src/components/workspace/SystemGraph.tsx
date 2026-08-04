import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { fetchSystemGraph, type GraphEdge, type GraphNode } from './api'
import { BigState, Loading, ViewHeader } from './parts'
import { NODE_HEIGHT, NODE_WIDTH, layoutSystem, readPins, writePin } from './systemLayout'
import { useLiveView } from './useLiveView'

/**
 * THE SYSTEM TAB — a projection, never configuration.
 *
 * Nothing on this canvas is authored. Every node, edge and badge is computed
 * live from `objects` (`created_by_loop`, `watcher`) plus `runs` aggregates:
 * there is no topology table and no way for anyone to "wire" two loops, because
 * **loops never wire to loops — they meet at the instance layer.** An edge here
 * is a COUNT of tasks that flowed that way in the window, so the picture is a
 * record of what happened, not a diagram someone drew.
 *
 * The renderer is the preserved demo's: React Flow with deterministic banded
 * Dagre and manual pins (drag to arrange, saved locally, double-click to
 * release). Lazily imported by the shell so React Flow and Dagre stay out of the
 * base client bundle — the same discipline the product applies to Recharts.
 *
 * UNIT 8: the canvas takes the reference's `.system-view` furniture — the header
 * over a `.system-note` line, a bordered `.graph-panel`, the floating
 * `.canvas-key` legend and a `Fit view` control — and the node card is the
 * reference's `.system-node`: a loop is the green sensing hue, the unclaimed pool
 * a dashed tray, and YOU the one dark card, because the human is the one node on
 * the canvas that is not a machine.
 */

const KIND_GLYPH: Record<GraphNode['type'], string> = { loop: '↻', pool: '◇', you: '●' }

type NodeData = GraphNode & { pinned?: boolean; [key: string]: unknown }

function SystemNodeCard({ data, selected }: NodeProps) {
  const node = data as NodeData
  const waiting = (node.badges.questionsWaiting ?? 0) > 0
  const classes = ['system-node', `node-${node.type}`, waiting ? 'is-waiting' : '', selected ? 'is-selected' : '', node.pinned ? 'is-pinned' : '', node.status !== 'active' ? 'is-paused' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes}>
      <Handle id="t-top" type="target" position={Position.Top} className="ws-handle" />
      <Handle id="t-left" type="target" position={Position.Left} className="ws-handle" />
      <span className="node-icon" aria-hidden="true">
        {KIND_GLYPH[node.type]}
      </span>
      <span className="node-copy">
        <span className="node-name">{node.label ?? node.id}</span>
        <small>{subtitle(node)}</small>
      </span>
      {waiting && <strong className="node-badge">{node.badges.questionsWaiting}</strong>}
      <Handle id="s-bottom" type="source" position={Position.Bottom} className="ws-handle" />
      <Handle id="s-right" type="source" position={Position.Right} className="ws-handle" />
    </div>
  )
}

function subtitle(node: GraphNode): string {
  if (node.type === 'pool') return `${node.badges.openTasks ?? 0} unclaimed · oldest ${node.badges.oldestAgeHours ?? 0}h`
  if (node.type === 'you') return `${node.badges.questionsWaiting ?? 0} question(s) waiting`
  const parts = [node.badges.cadence ?? 'no cadence', node.badges.lastOutcome ?? 'no runs', `${node.badges.openTasks ?? 0} open`]
  return parts.join(' · ')
}

/**
 * A straight edge with its count printed at the midpoint.
 *
 * `lane` offsets both the PATH and its label perpendicular to the line. Two
 * loops routinely have more than one relation between them — a pair that asks
 * and answers, or produces and hands off — and drawn on the same axis their
 * labels landed exactly on top of each other, which made the one number the edge
 * exists to carry unreadable. `routeEdges` assigns the lane per source→target
 * pair, so a single edge is still dead straight and only a genuine bundle fans.
 */
function CountEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, data }: EdgeProps) {
  const meta = data as { lane?: number; reversed?: boolean } | undefined
  const lane = meta?.lane ?? 0
  // The bow and the label slide are computed in the BUNDLE's canonical
  // direction, not this edge's own. A pair that asks one way and answers the
  // other arrives here with source/target swapped, so a lane measured from the
  // edge's own source cancels out between the two — both offsets landed on the
  // same pixel and the labels printed through each other. A quadratic control
  // point is direction-agnostic, so the path can still be drawn from the real
  // source to the real target through the canonical bow.
  const [ax, ay, bx, by] = meta?.reversed ? [targetX, targetY, sourceX, sourceY] : [sourceX, sourceY, targetX, targetY]
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy) || 1
  // Unit normal, so the bow is a constant number of pixels at any angle.
  const nx = (-dy / length) * lane * 34
  const ny = (dx / length) * lane * 34
  const bowX = (ax + bx) / 2 + nx
  const bowY = (ay + by) / 2 + ny
  const path = lane === 0
    ? `M${sourceX},${sourceY} L${targetX},${targetY}`
    : `M${sourceX},${sourceY} Q${bowX},${bowY} ${targetX},${targetY}`
  // The label is nudged ALONG the edge as well as across it: the bow alone
  // separates two labels by less than a label is wide, and this layout is mostly
  // vertical, so the useful separation is the one in the axis the text is thin in.
  const slide = 0.24 * lane
  const labelX = ax + dx * (0.5 + slide) + nx * 0.7
  const labelY = ay + dy * (0.5 + slide) + ny * 0.7
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      <text className="ws-edge-label" x={labelX} y={labelY - 4} textAnchor="middle">
        {String((data as { label?: string } | undefined)?.label ?? '')}
      </text>
    </>
  )
}

const nodeTypes = { system: SystemNodeCard }
const edgeTypes = { count: CountEdge }

function toFlowNodes(nodes: GraphNode[], edges: GraphEdge[], pins: Record<string, { x: number; y: number }>): Node<NodeData>[] {
  const positions = layoutSystem(nodes, edges)
  return nodes.map((node) => ({
    id: node.id,
    type: 'system',
    position: pins[node.id] ?? positions.get(node.id) ?? { x: 0, y: 0 },
    data: { ...node, pinned: Boolean(pins[node.id]) },
  }))
}

/**
 * Pick the handle pair that makes an edge read as a straight line between the
 * two node centers — the demo's routing rule, kept because a banded layout is
 * mostly vertical and default handles would loop edges around the cards.
 *
 * It also assigns each edge a LANE within its source→target bundle: 0 for a
 * lone edge (dead straight, as before), then ±1, ±2 … so a pair that both asks
 * and answers fans apart instead of printing two counts on the same pixel. The
 * lane keys on the unordered pair, so an A→B and a B→A edge share one bundle and
 * cannot collide either.
 */
function routeEdges(nodes: Node<NodeData>[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const bundleKey = (edge: GraphEdge) => [edge.from, edge.to].sort().join('|')
  const bundleSize = new Map<string, number>()
  for (const edge of edges) bundleSize.set(bundleKey(edge), (bundleSize.get(bundleKey(edge)) ?? 0) + 1)
  const seen = new Map<string, number>()

  return edges.flatMap((edge) => {
    const source = byId.get(edge.from)
    const target = byId.get(edge.to)
    if (!source || !target) return []
    const key = bundleKey(edge)
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    const size = bundleSize.get(key) ?? 1
    // Centre the bundle on the straight line: 1 edge ⇒ 0; 2 ⇒ -0.5, +0.5; 3 ⇒ -1, 0, +1.
    const lane = size === 1 ? 0 : index - (size - 1) / 2
    // Which way this edge runs relative to the bundle's canonical (sorted) pair.
    const reversed = edge.from > edge.to
    const dx = target.position.x - source.position.x
    const dy = target.position.y - source.position.y
    const horizontal = Math.abs(dx) > Math.abs(dy)
    return [
      {
        id: `${edge.from}→${edge.to}:${edge.kind}`,
        source: edge.from,
        target: edge.to,
        type: 'count',
        sourceHandle: horizontal ? 's-right' : 's-bottom',
        targetHandle: horizontal ? 't-left' : 't-top',
        className: `ws-edge ws-edge-${edge.kind}`,
        data: { label: `${edge.kind} ×${edge.count}`, lane, reversed },
        markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11 },
      },
    ]
  })
}

function Canvas({ nodes: raw, edges: rawEdges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const storage = typeof window === 'undefined' ? undefined : window.localStorage
  const base = useMemo(() => toFlowNodes(raw, rawEdges, {}), [raw, rawEdges])
  const initial = useMemo(() => toFlowNodes(raw, rawEdges, readPins(storage)), [raw, rawEdges, storage])
  const [nodes, setNodes, onNodesChange] = useNodesState(initial)
  const { fitView } = useReactFlow()
  const settled = useRef(false)

  useEffect(() => setNodes(initial), [initial, setNodes])
  useEffect(() => {
    if (settled.current) return
    settled.current = true
    const timer = window.setTimeout(() => void fitView({ padding: 0.1, duration: 380, maxZoom: 1.1 }), 80)
    return () => window.clearTimeout(timer)
  }, [fitView])

  const edges = useMemo(() => routeEdges(nodes, rawEdges), [nodes, rawEdges])

  const reset = useCallback(() => {
    storage?.removeItem('loopany-workspace-system-layout-v1')
    setNodes(base)
    window.setTimeout(() => void fitView({ padding: 0.1, duration: 380, maxZoom: 1.1 }), 50)
  }, [base, fitView, setNodes, storage])

  return (
    <div className="graph-panel">
      <div className="canvas-key">
        <span>
          <i className="edge-produces" /> produces
        </span>
        <span>
          <i className="edge-adopts" /> adopts
        </span>
        <span>
          <i className="edge-hands-off" /> hands-off
        </span>
        <span>
          <i className="edge-asks" /> asks
        </span>
        <span>
          <i className="edge-answers" /> answers
        </span>
        <em>Drag to arrange · saved locally · double-click to release</em>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => {
          writePin(storage, node.id, node.position)
          setNodes((current) => current.map((candidate) => (candidate.id === node.id ? { ...candidate, data: { ...candidate.data, pinned: true } } : candidate)))
        }}
        onNodeDoubleClick={(_, node) => {
          writePin(storage, node.id, null)
          const original = base.find((candidate) => candidate.id === node.id)
          if (original) setNodes((current) => current.map((candidate) => (candidate.id === node.id ? original : candidate)))
        }}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1.1 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesDraggable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={0.7} color="#e5e2dc" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <button type="button" className="fit-system" onClick={reset}>
        Reset layout
      </button>
    </div>
  )
}

export default function SystemGraph() {
  const { data, error } = useLiveView('system-graph', () => fetchSystemGraph())
  if (error && !data) return <BigState title="The system graph is not answering">{error.message}</BigState>
  if (!data) return <Loading what="the system graph" />
  return (
    <div className="system-view">
      <ViewHeader
        eyebrow="System"
        title="System"
        description="A projection of live data — creator → watcher flows, questions routed through you, unwatched products flowing to the pool. Nothing here is configured."
        meta={`${data.nodes.length} node${data.nodes.length === 1 ? '' : 's'} · ${data.edges.length} edge${data.edges.length === 1 ? '' : 's'}`}
      />
      <div className="system-note">
        <span>Last {data.window.days} days</span>
        An edge is a COUNT of tasks that flowed that way, so this is a record of what happened — not a diagram anyone drew.
      </div>
      <ReactFlowProvider>
        <Canvas nodes={data.nodes} edges={data.edges} />
      </ReactFlowProvider>
    </div>
  )
}
