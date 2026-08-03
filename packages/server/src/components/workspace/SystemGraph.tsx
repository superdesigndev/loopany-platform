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
import { Loading, Refusal } from './parts'
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
 */

const KIND_GLYPH: Record<GraphNode['type'], string> = { loop: '↻', pool: '◇', you: '●' }

type NodeData = GraphNode & { pinned?: boolean; [key: string]: unknown }

function SystemNodeCard({ data, selected }: NodeProps) {
  const node = data as NodeData
  const waiting = (node.badges.questionsWaiting ?? 0) > 0
  const classes = ['ws-node', `ws-node-${node.type}`, waiting ? 'is-waiting' : '', selected ? 'is-selected' : '', node.pinned ? 'is-pinned' : '', node.status !== 'active' ? 'is-paused' : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes}>
      <Handle id="t-top" type="target" position={Position.Top} className="ws-handle" />
      <Handle id="t-left" type="target" position={Position.Left} className="ws-handle" />
      <span className="ws-node-icon" aria-hidden="true">
        {KIND_GLYPH[node.type]}
      </span>
      <span className="ws-node-copy">
        <span className="ws-node-name">{node.label ?? node.id}</span>
        <small>{subtitle(node)}</small>
      </span>
      {waiting && <strong className="ws-node-badge">{node.badges.questionsWaiting}</strong>}
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

function CountEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, data }: EdgeProps) {
  const midX = (sourceX + targetX) / 2
  const midY = (sourceY + targetY) / 2
  return (
    <>
      <BaseEdge id={id} path={`M${sourceX},${sourceY} L${targetX},${targetY}`} markerEnd={markerEnd} style={style} />
      <text className="ws-edge-label" x={midX} y={midY} textAnchor="middle">
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

/** Pick the handle pair that makes an edge read as a straight line between the
 *  two node centers — the demo's routing rule, kept because a banded layout is
 *  mostly vertical and default handles would loop edges around the cards. */
function routeEdges(nodes: Node<NodeData>[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return edges.flatMap((edge) => {
    const source = byId.get(edge.from)
    const target = byId.get(edge.to)
    if (!source || !target) return []
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
        data: { label: `${edge.kind} ×${edge.count}` },
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
    <div className="ws-graph">
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
        <Background variant={BackgroundVariant.Dots} gap={26} size={0.7} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <button type="button" className="ws-graph-reset" onClick={reset}>
        Reset layout
      </button>
    </div>
  )
}

export default function SystemGraph() {
  const { data, error } = useLiveView('system-graph', () => fetchSystemGraph())
  if (error && !data) return <Refusal error={error} />
  if (!data) return <Loading what="the system graph" />
  return (
    <div className="ws-pane ws-graph-pane">
      <header className="ws-pane-head">
        <div>
          <h1>System</h1>
          <p>
            A projection of live data — creator → watcher flows over the last {data.window.days} days, questions routed through you, unwatched products
            flowing to the pool. Nothing here is configured.
          </p>
        </div>
        <div className="ws-graph-key">
          <span className="ws-edge-key ws-edge-produces">produces</span>
          <span className="ws-edge-key ws-edge-adopts">adopts</span>
          <span className="ws-edge-key ws-edge-hands-off">hands-off</span>
          <span className="ws-edge-key ws-edge-asks">asks</span>
          <span className="ws-edge-key ws-edge-answers">answers</span>
          <em>Drag to arrange · saved locally · double-click a node to release it</em>
        </div>
      </header>
      <ReactFlowProvider>
        <Canvas nodes={data.nodes} edges={data.edges} />
      </ReactFlowProvider>
    </div>
  )
}
