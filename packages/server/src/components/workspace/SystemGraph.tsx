import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from 'd3-force'
import '@xyflow/react/dist/style.css'

import type { SystemEdge, SystemNode } from './api'

/**
 * The System view's class graph.
 *
 * Same force-directed, band-anchored layout as the reference demo — but every
 * node and edge arrives from `/api/graph/system`, which reads the `objects` and
 * `edges` tables and DERIVES the gate nodes from open gate obligations. Nothing
 * on this canvas is authored: a gate appears because a transition opened an
 * obligation, and its badge is the live open count.
 *
 * Loaded lazily by the workspace shell so React Flow and d3-force stay out of
 * the base client bundle (the same discipline `LoopDetailView` applies to
 * Recharts).
 */

const MARGIN_X = 76
const COLUMN_GAP = 204
const NODE_CENTER_X = 84
const NODE_CENTER_Y = 29
const BAND_Y: Record<string, number> = {
  platform: 100,
  engineering: 240,
  marketing: 380,
  bizops: 520,
  monitors: 660,
  shared: 800,
}

type NodeData = SystemNode & { pinned?: boolean; [key: string]: unknown }
type SimNode = { id: string; x: number; y: number; fx?: number | null; fy?: number | null; band: string; kind: string; yOffset: number }
type SimLink = { source: string | SimNode; target: string | SimNode; relation: boolean }

const KIND_ICON: Record<string, string> = { sensor: '⌁', gate: '◇', human: '●', machine: '⌘', loop: '↻' }

function ClassNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const waiting = d.kind === 'gate' && (d.waiting ?? 0) > 0
  const hasArtifacts = Boolean(d.artifactIds?.length)
  const classes = [
    'system-node',
    `kind-${d.kind}`,
    waiting ? 'is-waiting' : '',
    selected ? 'is-selected' : '',
    d.pinned ? 'is-pinned' : '',
    hasArtifacts ? 'has-artifacts' : '',
    d.planned ? 'is-planned' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} data-kind={d.kind}>
      {d.bandLabel && <span className="node-band-label">{d.bandLabel}</span>}
      <Handle type="target" position={Position.Left} />
      <span className="node-icon" aria-hidden="true">
        {KIND_ICON[d.kind] ?? '↻'}
      </span>
      <span className="node-copy">
        <span className="node-name">{d.name}</span>
        <small>{d.eyebrow}</small>
      </span>
      {d.badge !== undefined && <strong className="node-badge">{d.badge}</strong>}
      {d.planned && <span className="node-planned-tag">planned</span>}
      <Handle type="source" position={Position.Right} />
      <div className="node-tooltip" role="tooltip">
        <small>{d.eyebrow}</small>
        <b>{d.name}</b>
        <span>{d.stat}</span>
        {d.planned && <em>Planned class · no runs yet</em>}
        {hasArtifacts && <em>Open what it is holding in Library →</em>}
      </div>
    </div>
  )
}

const nodeTypes = { system: ClassNode }

/** A relation arcs over the bands instead of cutting through them. */
function RelationEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const arcY = targetY < sourceY ? Math.min(sourceY, targetY) - 85 : Math.max(sourceY, targetY) + 85
  const path = `M${sourceX},${sourceY} C${sourceX + 70},${arcY} ${targetX - 70},${arcY} ${targetX},${targetY}`
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
}

const edgeTypes = { relation: RelationEdge }

function Canvas({ view, onOpenArtifacts }: { view: { nodes: SystemNode[]; edges: SystemEdge[] }; onOpenArtifacts: (ids: string[]) => void }) {
  const anchors = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    for (const n of view.nodes) {
      map.set(n.id, { x: MARGIN_X + n.rank * COLUMN_GAP, y: (BAND_Y[n.band] ?? 100) + (n.yOffset ?? 0) })
    }
    return map
  }, [view.nodes])

  const initialNodes = useMemo<Node<NodeData>[]>(() => {
    // Deterministic jitter: the same graph always lays out the same way, so a
    // reload is not a different picture of the same workspace.
    let seed = 42
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    return view.nodes.map((n) => {
      const a = anchors.get(n.id)!
      return {
        id: n.id,
        type: 'system',
        position: { x: a.x - NODE_CENTER_X + (random() - 0.5) * 32, y: a.y - NODE_CENTER_Y + (random() - 0.5) * 70 },
        data: { ...n } as NodeData,
      }
    })
  }, [view.nodes, anchors])

  const initialEdges = useMemo<Edge[]>(
    () =>
      view.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: e.animated,
        type: e.relation ? 'relation' : 'default',
        className: [e.relation ? 'edge-dashed' : '', e.shared ? 'edge-shared' : '', e.planned ? 'edge-planned' : ''].filter(Boolean).join(' '),
        data: { relation: Boolean(e.relation) },
        style: { strokeDasharray: e.relation ? '6 7' : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10 },
        labelStyle: { fontSize: 9, fill: '#9a9892', fontWeight: 500 },
        labelBgStyle: { fill: '#fbfaf8', fillOpacity: 0.92 },
        labelBgPadding: [4, 2] as [number, number],
      })),
    [view.edges],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState(initialEdges)
  const [showInfrastructure, setShowInfrastructure] = useState(false)
  const simulationRef = useRef<Simulation<SimNode, undefined> | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  const nodesRef = useRef(nodes)
  const openTimerRef = useRef<number | null>(null)
  const { fitView } = useReactFlow()

  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  const visibleIds = useMemo(
    () => new Set(view.nodes.filter((n) => showInfrastructure || n.band !== 'shared').map((n) => n.id)),
    [view.nodes, showInfrastructure],
  )
  const visibleNodes = nodes.filter((n) => visibleIds.has(n.id))
  const visibleEdges = edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))

  useEffect(() => {
    const active = nodesRef.current.filter((n) => visibleIds.has(n.id))
    const activeIds = new Set(active.map((n) => n.id))
    const simNodes: SimNode[] = active.map((n) => ({
      id: n.id,
      x: n.position.x + NODE_CENTER_X,
      y: n.position.y + NODE_CENTER_Y,
      fx: n.data.pinned ? n.position.x + NODE_CENTER_X : null,
      fy: n.data.pinned ? n.position.y + NODE_CENTER_Y : null,
      band: n.data.band,
      kind: n.data.kind,
      yOffset: n.data.yOffset ?? 0,
    }))
    const links: SimLink[] = view.edges
      .filter((e) => activeIds.has(e.source) && activeIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, relation: Boolean(e.relation) }))
    simNodesRef.current = simNodes

    const simulation = forceSimulation(simNodes)
      .randomSource(() => 0.42)
      .alphaDecay(0.025)
      .velocityDecay(0.42)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((link) => {
            const src = typeof link.source === 'string' ? link.source : link.source.id
            const dst = typeof link.target === 'string' ? link.target : link.target.id
            if (link.relation) return 170
            return src === 'you' || dst === 'you' ? 185 : COLUMN_GAP
          })
          .strength((link) => (link.relation ? 0.025 : 0.12)),
      )
      .force('charge', forceManyBody().strength(-90).distanceMax(290))
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((d) => (d.kind === 'human' ? 90 : 86))
          .strength(0.98)
          .iterations(3),
      )
      .force('x', forceX<SimNode>((d) => anchors.get(d.id)?.x ?? MARGIN_X).strength((d) => (d.band === 'shared' ? 0.76 : 0.98)))
      .force('y', forceY<SimNode>((d) => (BAND_Y[d.band] ?? 100) + d.yOffset).strength((d) => (d.band === 'shared' ? 0.62 : 0.9)))
      .on('tick', () =>
        setNodes((current) => {
          const next = current.map((n) => {
            const point = simNodes.find((p) => p.id === n.id)
            return point ? { ...n, position: { x: point.x - NODE_CENTER_X, y: point.y - NODE_CENTER_Y } } : n
          })
          nodesRef.current = next
          return next
        }),
      )
    simulationRef.current = simulation
    const fitTimer = window.setTimeout(() => void fitView({ padding: 0.16, duration: 550, maxZoom: 1.15 }), 850)
    return () => {
      window.clearTimeout(fitTimer)
      simulation.stop()
      simulationRef.current = null
    }
  }, [anchors, fitView, setNodes, view.edges, visibleIds])

  const setFixed = useCallback((node: Node, fixed: boolean) => {
    const point = simNodesRef.current.find((p) => p.id === node.id)
    if (!point) return
    point.fx = fixed ? node.position.x + NODE_CENTER_X : null
    point.fy = fixed ? node.position.y + NODE_CENTER_Y : null
  }, [])

  const setPinned = useCallback(
    (id: string, pinned: boolean) => setNodes((current) => current.map((n) => (n.id === id ? { ...n, data: { ...n.data, pinned } } : n))),
    [setNodes],
  )

  return (
    <div className="graph-panel">
      <div className="canvas-key">
        <span>
          <i className="flow" /> flow
        </span>
        <span>
          <i className="relation" /> relation
        </span>
        <span className="band-summary">Platform · Engineering · Marketing · Bizops · Monitors</span>
        <button className="infra-toggle" aria-pressed={showInfrastructure} onClick={() => setShowInfrastructure((v) => !v)}>
          {showInfrastructure ? 'Hide people & machines' : 'Show people & machines'}
        </button>
        <em>Drag to pin · double-click to release</em>
      </div>
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          const ids = (node.data as NodeData).artifactIds
          if (!ids?.length) return
          openTimerRef.current = window.setTimeout(() => onOpenArtifacts(ids), 220)
        }}
        onNodeDragStart={(_, node) => {
          setFixed(node, true)
          setPinned(node.id, false)
          simulationRef.current?.alphaTarget(0.18).restart()
        }}
        onNodeDrag={(_, node) => setFixed(node, true)}
        onNodeDragStop={(_, node) => {
          setFixed(node, true)
          setPinned(node.id, true)
          simulationRef.current?.alphaTarget(0).alpha(0.28).restart()
        }}
        onNodeDoubleClick={(_, node) => {
          if (openTimerRef.current) window.clearTimeout(openTimerRef.current)
          setFixed(node, false)
          setPinned(node.id, false)
          simulationRef.current?.alphaTarget(0).alpha(0.35).restart()
        }}
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
        minZoom={0.42}
        maxZoom={1.8}
        nodesDraggable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={0.65} color="#e5e2dc" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <button className="fit-system" onClick={() => void fitView({ padding: 0.16, duration: 500, maxZoom: 1.15 })}>
        Fit view
      </button>
    </div>
  )
}

export default function SystemGraph({ view, onOpenArtifacts }: { view: { nodes: SystemNode[]; edges: SystemEdge[] }; onOpenArtifacts: (ids: string[]) => void }) {
  return (
    <ReactFlowProvider>
      <Canvas view={view} onOpenArtifacts={onOpenArtifacts} />
    </ReactFlowProvider>
  )
}
