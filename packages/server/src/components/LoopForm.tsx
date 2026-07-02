import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import type { ChannelSummary, JobPayload, StateField } from '../types'
import { listChannels } from '../server/notifyFns'
import { cronText } from '../lib/format'
import { areaCls, inputCls, labelCls, selectCls } from './ui'
import { ModalSection } from './Modal'

export interface LoopFormHandle {
  /** Build the payload, or null if a field is invalid (the form alerts the user). */
  read: () => JobPayload | null
}

/** Loose seed accepted by the form — a full job (edit) or a partial draft (create). */
export interface LoopFormSeed {
  name?: string
  cron?: string
  taskFile?: string
  notify?: string
  channelId?: string | null
  workflow?: string
  stateSchema?: StateField[]
  ui?: string
  exec?: { workdir?: string; model?: string; allowControl?: boolean }
}

interface FormState {
  name: string
  cron: string
  taskFile: string
  notify: string
  channelId: string
  workflow: string
  stateSchema: string
  ui: string
  workdir: string
  model: string
  allowControl: boolean
}

function initState(initial?: LoopFormSeed): FormState {
  const e = initial?.exec
  return {
    name: initial?.name ?? '',
    cron: initial?.cron ?? '0 */3 * * *',
    taskFile: initial?.taskFile ?? '',
    notify: initial?.notify ?? 'auto',
    channelId: initial?.channelId ?? '',
    workflow: initial?.workflow ?? '',
    stateSchema: initial?.stateSchema ? JSON.stringify(initial.stateSchema) : '',
    ui: initial?.ui ?? '',
    workdir: e?.workdir ?? '',
    model: e?.model ?? '',
    allowControl: !!e?.allowControl,
  }
}

// Module-level so identity is stable across renders (an inner component would
// remount on each keystroke and drop input focus).
function TextField({
  label,
  value,
  onChange,
  mono,
  ph,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  ph?: string
}) {
  return (
    <div className="flex-1">
      <label className={labelCls}>{label}</label>
      <input
        type="text"
        className={mono ? `${inputCls} font-mono` : inputCls}
        value={value}
        placeholder={ph}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export const LoopForm = forwardRef<LoopFormHandle, { initial?: LoopFormSeed; channels?: ChannelSummary[] }>(
  function LoopForm({ initial, channels: channelsProp }, ref) {
    const [f, setF] = useState<FormState>(() => initState(initial))
    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))
    // The parent (LoopDetailView) already holds the team's channel list — reuse it
    // when handed down, and only self-fetch when rendered standalone.
    const [fetched, setFetched] = useState<ChannelSummary[]>([])
    const channels = channelsProp ?? fetched
    useEffect(() => {
      if (channelsProp) return
      void listChannels()
        .then(setFetched)
        .catch(() => {})
    }, [channelsProp])

    useImperativeHandle(ref, () => ({
      read(): JobPayload | null {
        let stateSchema: StateField[] | undefined
        const ss = f.stateSchema.trim()
        if (ss) {
          try {
            stateSchema = JSON.parse(ss)
          } catch {
            alert('stateSchema is not valid JSON')
            return null
          }
        }
        const exec = f.workdir.trim()
          ? {
              executor: 'claude' as const,
              workdir: f.workdir.trim(),
              model: f.model.trim() || undefined,
              allowControl: f.allowControl,
            }
          : undefined
        return {
          name: f.name.trim(),
          cron: f.cron.trim(),
          taskFile: f.taskFile.trim(),
          notify: f.notify,
          channelId: f.channelId || null,
          workflow: f.workflow.trim(),
          ui: f.ui.trim() || undefined,
          exec,
          stateSchema,
        }
      },
    }))

    return (
      <div>
        <div className="flex gap-3">
          <TextField label="Name" value={f.name} onChange={(v) => set('name', v)} />
          <div className="flex-1">
            <label className={labelCls}>cron · edit via agent</label>
            <div
              className={`${inputCls} flex items-center justify-between gap-2 cursor-default select-none`}
              title={f.cron}
            >
              <span className="text-primary">{cronText(f.cron)}</span>
              <span className="font-mono text-[11px] text-secondary">{f.cron}</span>
            </div>
          </div>
        </div>

        <TextField
          label="taskFile (the md it tracks/maintains on the machine, optional)"
          value={f.taskFile}
          onChange={(v) => set('taskFile', v)}
        />

        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelCls}>notify</label>
            <select className={selectCls} value={f.notify} onChange={(e) => set('notify', e.target.value)}>
              {['auto', 'always', 'never'].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className={labelCls}>push channel</label>
            <select className={selectCls} value={f.channelId} onChange={(e) => set('channelId', e.target.value)}>
              <option value="">none (dashboard only)</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <ModalSection>exec (bind claude on the machine as executor)</ModalSection>
        <TextField
          label="workdir (project root on the machine — empty ⇒ workflow-only / agent() escalation)"
          value={f.workdir}
          onChange={(v) => set('workdir', v)}
          mono
          ph="/Users/you/Workspace/project"
        />
        <TextField label="model (optional)" value={f.model} onChange={(v) => set('model', v)} />
        <label className="mt-3.5 flex items-center gap-2 text-sm text-primary">
          <input
            type="checkbox"
            className="accent-[color:var(--color-display)]"
            checked={f.allowControl}
            onChange={(e) => set('allowControl', e.target.checked)}
          />
          allowControl (allow self-rescheduling)
        </label>

        <label className={labelCls}>workflow (JS function body — zero-LLM; optional)</label>
        <textarea className={areaCls} value={f.workflow} onChange={(e) => set('workflow', e.target.value)} />

        <label className={labelCls}>stateSchema (per-run metrics, JSON array)</label>
        <textarea
          className={areaCls}
          value={f.stateSchema}
          placeholder='[{"key":"mrr","label":"MRR","unit":"$"},{"key":"paid"}]'
          onChange={(e) => set('stateSchema', e.target.value)}
        />

        <label className={labelCls}>ui (dashboard template · agent-authored HTML + bindings, optional)</label>
        <textarea
          className={`${areaCls} min-h-24`}
          value={f.ui}
          placeholder={'<h3>{{latest.mrr}}$</h3>\n<loop-chart series="mrr:MRR:$"></loop-chart>'}
          onChange={(e) => set('ui', e.target.value)}
        />
      </div>
    )
  },
)
