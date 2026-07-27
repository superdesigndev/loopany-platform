/**
 * <TaskTree/> — the worknode-style compact tree: monospace rows, a colored
 * status square, [P0]/[TYPE] chips, collapse triangles, real indentation for
 * hierarchy. Selection drives the host's right-hand detail pane (split view).
 *
 * Tree assembly reuses the SHARED pure builder (server/taskTree.ts) the machine
 * gateway serves the CLI from, so the two renderings can never disagree.
 *
 * Width discipline (repo hard rule — no page-level horizontal scroll): every
 * row is `min-w-0` with a truncating title; deep indentation narrows the title,
 * never widens the pane.
 */
import { useState } from 'react'

import { buildTaskTree, type TaskRow, type TaskTreeNode } from '../server/taskTree'
import { cronText } from '../lib/format'

/** Worknode board palette (the legend in the page header mirrors this). */
export const STATUS_COLOR: Record<string, string> = {
  idea: '#9aa0b0',
  todo: '#3b82f6',
  'in-progress': '#d35400',
  'follow-up': '#12a594',
  done: '#1f9d55',
  archived: '#c3c6cf',
}
export const PRIORITY_COLOR: Record<string, string> = {
  P0: '#c0392b',
  P1: '#d35400',
  P2: '#6b7280',
  P3: '#9aa0b0',
}

const today = (): string => new Date().toISOString().slice(0, 10)
const isDue = (r: TaskRow): boolean => r.status === 'follow-up' && !!r.follow_up_date && r.follow_up_date <= today()

/** The colored status square (■). Untyped/statusless rows get the idea gray. */
function StatusSquare({ status }: { status: string | null | undefined }) {
  return (
    <span
      className="inline-block h-[10px] w-[10px] shrink-0"
      style={{ backgroundColor: STATUS_COLOR[status ?? 'idea'] ?? STATUS_COLOR['idea'] }}
      title={status ? `status: ${status}` : undefined}
    />
  )
}

function Chip({ label, color }: { label: string; color?: string }) {
  return (
    <span
      className="inline-block shrink-0 border border-wire bg-surface px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.04em]"
      style={color ? { color, borderColor: color } : undefined}
    >
      {label}
    </span>
  )
}

/** Recursively drop done/archived subtrees when the toggle is off. */
function pruneDone(nodes: TaskTreeNode[]): TaskTreeNode[] {
  return nodes
    .filter((n) => n.status !== 'done' && n.status !== 'archived')
    .map((n) => ({ ...n, children: pruneDone(n.children) }))
}

function Row({
  node,
  depth,
  selectedId,
  collapsed,
  onSelect,
  onToggle,
}: {
  node: TaskTreeNode
  depth: number
  selectedId: string | null
  collapsed: Set<string>
  onSelect: (row: TaskRow) => void
  onToggle: (loopId: string) => void
}) {
  const hasKids = node.children.length > 0
  const isCollapsed = collapsed.has(node.loopId)
  const selected = selectedId === node.loopId
  const due = isDue(node)
  return (
    <>
      <div
        className={`flex min-w-0 items-center gap-2 border py-[5px] pr-2 font-mono text-[13px] ${
          selected ? 'border-display bg-surface' : 'border-transparent hover:bg-surface/60'
        }`}
        style={{ paddingLeft: `${10 + depth * 24}px` }}
      >
        <button
          onClick={() => hasKids && onToggle(node.loopId)}
          aria-label={hasKids ? (isCollapsed ? 'expand' : 'collapse') : undefined}
          className={`w-4 shrink-0 text-center text-[10px] text-secondary ${hasKids ? 'cursor-pointer hover:text-display' : 'cursor-default'}`}
        >
          {hasKids ? (isCollapsed ? '▶' : '▼') : ''}
        </button>
        <button onClick={() => onSelect(node)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
          <StatusSquare status={node.status} />
          {node.priority && <Chip label={node.priority} color={PRIORITY_COLOR[node.priority]} />}
          {node.type && <Chip label={node.type.toUpperCase()} />}
          <span className={`min-w-0 truncate ${node.status === 'done' || node.status === 'archived' ? 'text-secondary line-through' : 'text-display'}`}>
            {node.title}
          </span>
          {node.cron && (
            <span className="shrink-0 text-[11px] text-secondary" title={node.cron}>
              ⟳ {cronText(node.cron)}
              {node.enabled ? '' : ' ·paused'}
            </span>
          )}
          {node.follow_up_date && (
            <span className={`shrink-0 text-[11px] ${due ? 'font-semibold text-[#c0392b]' : 'text-secondary'}`}>⏰ {node.follow_up_date}</span>
          )}
        </button>
      </div>
      {!isCollapsed &&
        node.children.map((c) => (
          <Row key={c.loopId} node={c} depth={depth + 1} selectedId={selectedId} collapsed={collapsed} onSelect={onSelect} onToggle={onToggle} />
        ))}
      {!isCollapsed && node.childrenTruncated ? (
        <div className="py-1 font-mono text-[11px] text-secondary" style={{ paddingLeft: `${34 + (depth + 1) * 24}px` }}>
          … {node.childrenTruncated} more below
        </div>
      ) : null}
    </>
  )
}

export function TaskTree({
  rows,
  selectedId,
  onSelect,
  showDone,
}: {
  rows: TaskRow[]
  selectedId: string | null
  onSelect: (row: TaskRow) => void
  showDone: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const onToggle = (loopId: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(loopId) ? next.delete(loopId) : next.add(loopId)
      return next
    })

  const typed = rows.filter((r) => r.slug != null)
  const untyped = rows.filter((r) => r.slug == null)
  let tree = buildTaskTree(typed, { depth: 99 })
  if (!showDone) tree = pruneDone(tree)

  if (!rows.length) {
    return (
      <div className="px-4 py-8 text-[13px] text-secondary">
        No tasks yet — start one from a connected machine: <code className="font-mono text-[12px]">loopany create "&lt;title&gt;"</code>
      </div>
    )
  }

  return (
    <div className="min-w-0 py-2">
      {tree.map((n) => (
        <Row key={n.loopId} node={n} depth={0} selectedId={selectedId} collapsed={collapsed} onSelect={onSelect} onToggle={onToggle} />
      ))}
      {untyped.length > 0 && (
        <>
          {/* Legacy loops whose README has no task front matter — listed so the
              page is complete on day one, zero backfill required. */}
          <div className="mt-4 px-3 font-mono text-[10px] tracking-[0.2em] text-secondary">LOOPS (UNTYPED)</div>
          {untyped.map((r) => (
            <Row
              key={r.loopId}
              node={{ ...r, children: [] }}
              depth={0}
              selectedId={selectedId}
              collapsed={collapsed}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </div>
  )
}
