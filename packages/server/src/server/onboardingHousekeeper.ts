/**
 * The canned Housekeeper (Tech Debt Cleanup) loop config the onboarding SIM shim
 * creates — a faithful stand-in for what the coding agent would author from the
 * template `description` + create.md: daily ~7am, a task-file loop, with a day-one
 * dashboard (kanban of cleanup cards + a chart of cleanups landed).
 *
 * DEV-SIM ONLY: the real flow always builds the loop on the user's machine from the
 * pasted bootstrap + template prompt. This is just the shape the simulated create
 * writes so the demo dashboard looks real. Kept beside the sim so the two live and
 * die together; it is imported by nothing in the production path.
 */
export const HOUSEKEEPER_LOOP = {
  name: 'Housekeeper',
  cron: '0 7 * * *',
  taskFile: 'housekeeper/TASK.md',
  agent: 'claude-code' as const,
  ui: [
    '<h2>Cleanups</h2>',
    '<loop-kanban columns="open,merged" match="cleanups/*.md"></loop-kanban>',
    '<loop-chart series="cleanups:Cleanups landed"></loop-chart>',
  ].join('\n'),
}
