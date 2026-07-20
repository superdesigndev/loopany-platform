import { useState, type ReactNode } from 'react'

/**
 * <loop-tabs tabs="A,B,C"> — a tab strip over its top-level <section> children:
 * one label per section, in order, only the active section rendered. Purely
 * presentational (no data fetching of its own); the sections hold ordinary
 * dashboard HTML including other loop-* primitives. Extra labels beyond the
 * section count (or vice versa) are ignored pairwise, so a half-edited template
 * degrades to fewer tabs instead of breaking.
 */
export function LoopTabs({ labels, panels }: { labels: string[]; panels: ReactNode[] }) {
  const tabs = labels.slice(0, panels.length)
  const [active, setActive] = useState(0)
  if (!tabs.length) return null
  const current = Math.min(active, tabs.length - 1)
  return (
    <div className="min-w-0">
      <div className="mb-3 inline-flex overflow-hidden rounded-control border border-hairline">
        {tabs.map((label, i) => (
          <button
            key={`${i}:${label}`}
            type="button"
            onClick={() => setActive(i)}
            className={`cursor-pointer border-none px-3 py-1 text-caption font-medium transition-colors ${
              current === i ? 'bg-raised text-display' : 'bg-transparent text-secondary hover:text-display'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-w-0">{panels[current]}</div>
    </div>
  )
}
