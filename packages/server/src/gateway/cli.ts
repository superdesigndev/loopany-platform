/**
 * CLI dispatch - the credential-keyed verb router half of the machine gateway,
 * split out of `MachineGateway` (which keeps poll/report/sweep/owner verbs).
 * Same wire surface, framework-agnostic like the rest of the gateway
 * (`{ status, body }` results):
 *
 *   POST /api/machine/cli  (Bearer device OR run credential) → unified dispatch
 *   POST /agent-api/loop   (Bearer run token)                → the `loopany` shim's verbs
 *
 * The verb router keys authority on CREDENTIAL TYPE first (`dk_` device prefix
 * vs run-lease lookup, bare-UUID back-compat) and reuses the core gateway
 * methods (`createLoop`/`editLoop`/`loopLog`/`renderLoopLog`/`finishLoop`)
 * through the injected `MachineGateway`, so floors/allowControl/canFinish and
 * the flat-404 scoping flow through unchanged. The agent-api verb dispatch is a
 * compact port of c0's control.ts: report/show + the allowControl schedule
 * mutations, plus set-ui/schema/workflow gated to the evolution pass (the
 * evolve run-token carries the canSet* caps).
 */
import path from "node:path";

import * as store from "../db/store.js";
import type { ControlAction, Loop, NotifyPolicy, RunRole, RunStatus, StateField } from "../db/schema.js";
import { machinePresence, type MachinePresence } from "../lib/machinePresence.js";
import { selfCronFloorMinutes, selfRescheduleFloorMinutes } from "../env.js";
import { machineIdFromToken, resolveLease, type RunLease } from "./tokens.js";
import {
  ABSENT,
  codeForStatus,
  detailBlock,
  doc,
  emptyList,
  errorBlock,
  helpBlock,
  kvLine,
  listBlock,
  scalar,
  truncate,
  type Scalar,
} from "./toon.js";
import {
  EDITABLE_LOOP_FIELDS,
  LOG_MESSAGE_CELL_CAP,
  LOG_RUNS_DEFAULT,
  MAX_NEXT_MS,
  MESSAGE_CAP,
  fmtTime,
  fmtTimeZoned,
  invalidTimezoneError,
  nextFires,
  parseWhen,
  runMetricsToken,
  runOutcomeToken,
  validCadence,
  validTimezone,
  type Applied,
  type MachineGateway,
} from "./index.js";
import { validateSchema, validateUi, validateWorkflow } from "./validate.js";
import { nowIso, stripNul, type HttpResult } from "./http.js";

export class CliGateway {
  constructor(
    /** The run-lifecycle core: the CLI verbs reuse its owner methods
     *  (createLoop/listLoops/editLoop/loopLog), the shared `renderLoopLog`
     *  scoping body, `finishLoop`, and the scheduler (schedule re-arm). */
    private readonly gateway: MachineGateway,
  ) {}

  // ---- POST /agent-api/loop ----

  async agentApi(runToken: string, argv: string[]): Promise<HttpResult> {
    const lease = await resolveLease(runToken);
    if (!lease) return { status: 401, body: { text: errorBlock("invalid or expired token", "UNAUTHORIZED"), exitCode: 1 } };
    // The run was already reclaimed by the server (the machine was likely asleep).
    // Its lease is terminal-grace: it lives on only to accept ONE reconciling
    // wake-report via /machine/report — never further agent-api mutations
    // (reschedule/set-*/finish).
    if (lease.state === "terminal-grace") {
      return { status: 409, body: { text: errorBlock(RECLAIMED_MSG, "CONFLICT"), exitCode: 1 } };
    }
    const out = await this.dispatch(lease, argv);
    return { status: out.code, body: { text: out.text, exitCode: out.code === 200 ? 0 : 1 } };
  }

  // ---- POST /api/machine/cli — one CLI dispatch, keyed by credential ----

  /**
   * The unified CLI endpoint. It is a ROUTER in front of the gateway logic that
   * already exists — never a rewrite — that keys authority on the CREDENTIAL TYPE
   * first, then routes to the same methods the legacy endpoints call:
   *   · DEVICE credential (`dk_`-prefixed) → owner authority over any loop bound to
   *     the machine: `new`→createLoop, `loops`→listLoops, `edit`→editLoop,
   *     `log`→loopLog, `show`→describe. `report`/`finish` are RUN-only (403).
   *   · RUN credential (an `rk_`-prefixed run lease — or a bare-UUID token from a
   *     pre-Batch-6 mint over a deploy) → the least-privilege per-run `dispatch()`
   *     verbs, PLUS a read branch (`log`/`show`) scoped strictly to the lease's OWN
   *     loop — this closes the in-run `loopany log` 400 seam. Owner-only verbs
   *     (`new`/`edit`/`loops`/`status`) are 403 for a run credential.
   * The branch keys on the `dk_` device prefix, NOT an `rk_` run prefix, so a
   * bare-UUID run token still routes to the run path (it just isn't a device token).
   * Floors, `allowControl`, `canFinish`, and the shared content validators all flow
   * through the reused `dispatch`/`createLoop`/`editLoop`/`loopLog` unchanged.
   */
  async cli(token: string, argv: string[]): Promise<HttpResult> {
    const res = token.startsWith("dk_") ? await this.deviceCli(token, argv) : await this.runCli(token, argv);
    return finalizeCli(res);
  }

  /** DEVICE-credential branch of the unified CLI. */
  private async deviceCli(deviceToken: string, argv: string[]): Promise<HttpResult> {
    const machineId = machineIdFromToken(deviceToken);
    const verb = argv[0] ?? "";
    // The content-first home (P8): bare `loopany` posts `["home"]`. It renders a
    // DEFINITIVE state for an unregistered machine ("not connected — run `loopany
    // up`") rather than a 401, so the ambient dashboard is never an error/empty —
    // handled BEFORE the unknown-machine guard the other verbs sit behind.
    if (verb === "home") return { status: 200, body: { ok: true, text: await this.homeDevice(machineId, parseFlags(argv.slice(1))) } };
    if (!(await store.getMachine(machineId))) return { status: 401, body: { error: "unknown machine (token not registered)" } };
    const flags = parseFlags(argv.slice(1));
    const loopArg = typeof flags["loop"] === "string" ? (flags["loop"] as string) : typeof flags["_"] === "string" ? (flags["_"] as string) : "";

    // Per-verb `--help` (P10): full owner-facing help for a device verb (no lease ⇒
    // no availability caveats). An unknown verb has no help spec → falls through to
    // the switch's default (unknown-command 400), matching today's behavior.
    if (flags["help"] === true) {
      const h = verbHelpText(verb);
      if (h) return { status: 200, body: { ok: true, text: h } };
    }

    switch (verb) {
      case "new": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        const config = { ...parsed.value } as Record<string, unknown>;
        if (flags["dry-run"] === true) config.dryRun = true;
        return this.gateway.createLoop(deviceToken, config);
      }
      case "loops":
        return this.gateway.listLoops(deviceToken, typeof flags["fields"] === "string" ? (flags["fields"] as string) : undefined, flags["json"] === true);
      case "edit": {
        const parsed = parseJsonFlag(flags["json"]);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        return this.gateway.editLoop(deviceToken, loopArg || undefined, parsed.value as Record<string, unknown>, flags["dry-run"] === true);
      }
      case "log":
        return this.gateway.loopLog(deviceToken, loopArg, flags["limit"]);
      case "show": {
        // Device `show` may inspect ANY loop bound to the machine; the machine-scope
        // check mirrors loopLog/editLoop (flat 404, existence never leaks).
        const loop = loopArg ? await store.getLoop(loopArg) : undefined;
        if (!loop || loop.machineId !== machineId) return { status: 404, body: { error: "no such loop on this machine" } };
        // `--json`: emit the full editable envelope with complete bodies (the exact
        // `edit --json` shape; the roundtrip transport, §4.1). Otherwise the TOON
        // detail view (size hints by default, full bodies under `--full`).
        if (flags["json"] === true) {
          const env = loopEnvelope(loop);
          return { status: 200, body: { ok: true, loop: env, text: JSON.stringify(env, null, 2) } };
        }
        return { status: 200, body: { ok: true, text: await this.describe(loop.id, { full: flags["full"] === true }) } };
      }
      case "report":
      case "finish":
      case "complete":
        // Per §4.1: there is no run to attribute a device-credential report/finish to.
        return { status: 403, body: { error: `loopany: "${verb}" is a run-only verb — a run reports/finishes itself; the owner edits via "edit"` } };
      default:
        return { status: 400, body: { error: `loopany: unknown command "${verb}" for the device credential (try: new, loops, edit, log, show)` } };
    }
  }

  /** RUN-credential branch of the unified CLI: the existing per-run `dispatch()`
   *  verbs, plus the read branch (`log`/`show`) scoped to the lease's own loop. */
  private async runCli(runToken: string, argv: string[]): Promise<HttpResult> {
    const lease = await resolveLease(runToken);
    if (!lease) return { status: 401, body: { text: errorBlock("invalid or expired token", "UNAUTHORIZED"), exitCode: 1 } };
    // Reclaimed (machine likely asleep) — terminal-grace accepts only the reconciling
    // /machine/report, never further CLI mutations. Same rule agentApi enforces.
    if (lease.state === "terminal-grace") {
      return { status: 409, body: { text: errorBlock(RECLAIMED_MSG, "CONFLICT"), exitCode: 1 } };
    }
    const verb = argv[0] ?? "";
    const flags = parseFlags(argv.slice(1));

    // Owner-only verbs are never reachable with a run credential (least-privilege):
    // a run has no create/edit/cross-loop-list/machine-status need. Explicit 403 so
    // the denial is legible (not a generic "unknown command").
    if (DEVICE_ONLY_VERBS.has(verb)) {
      return { status: 403, body: { text: errorBlock(`"${verb}" needs the device credential (owner authority); a run may only act on its own loop`, "FORBIDDEN"), exitCode: 1 } };
    }

    // Loop-arg fence: a run may only target its OWN loop. An explicit `--loop` (any
    // verb) or a positional loop id (only `log`/`show` take one) that names another
    // loop is a hard 403 — never a silent retarget onto the run's own loop.
    const targeted = typeof flags["loop"] === "string" ? (flags["loop"] as string) : (verb === "log" || verb === "show") && typeof flags["_"] === "string" ? (flags["_"] as string) : undefined;
    if (targeted !== undefined && targeted !== lease.loopId) {
      return { status: 403, body: { text: errorBlock("a run may only act on its own loop", "FORBIDDEN"), exitCode: 1 } };
    }

    // Per-verb `--help` (P10), role-aware from the lease caps. Covers the read verbs
    // (`log`/`show`) that runCli handles before/around `dispatch` AND the dispatch
    // verbs, so `<verb> --help` is uniform on the run path. An owner-only verb was
    // already 403'd above; an unknown verb has no spec → falls through to `dispatch`
    // (unknown-command 400).
    if (flags["help"] === true) {
      const h = verbHelpText(verb, lease);
      if (h) return { status: 200, body: { text: h, exitCode: 0 } };
    }

    // Content-first home (P8), in-run: bare `loopany` inside a run posts `["home"]`
    // and gets the run's OWN loop context (identity + role + goal + recent runs),
    // scoped strictly to the lease's loop (no cross-loop leak).
    if (verb === "home") {
      return { status: 200, body: { text: await this.homeRun(lease), exitCode: 0 } };
    }

    // Read branch — the seam fix. `log` gains a run-credential path (it has no case
    // in `dispatch`, so today it 400s in-run); `show` TOON stays in `dispatch`
    // (already scoped to lease.loopId with the run's caps), but `show --json` needs a
    // structured body (`dispatch` returns text-only), so it is served here.
    if (verb === "log") {
      return this.gateway.renderLoopLog(lease.machineId, lease.loopId, flags["limit"]);
    }
    if (verb === "show" && flags["json"] === true) {
      const loop = await store.getLoop(lease.loopId);
      if (!loop) return { status: 404, body: { text: errorBlock("loop not found", "NOT_FOUND"), exitCode: 1 } };
      // The full editable envelope — identical shape to the device `show --json`
      // (the run's effective selfSchedule/selfFinish lines are TOON-only, not in the
      // read/write envelope). Scoped to the run's own loop (fenced above).
      const env = loopEnvelope(loop);
      return { status: 200, body: { ok: true, loop: env, text: JSON.stringify(env, null, 2), exitCode: 0 } };
    }

    const out = await this.dispatch(lease, argv);
    return { status: out.code, body: { text: out.text, exitCode: out.code === 200 ? 0 : 1 } };
  }

  // ---- agent-api verb dispatch (compact port of control.ts) ----

  private async dispatch(lease: RunLease, argv: string[]): Promise<{ code: number; text: string }> {
    const verb = argv[0];
    const flags = parseFlags(argv.slice(1));
    const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

    // Per-verb `--help` (P10): a concrete verb carrying `--help` gets that verb's
    // syntax + flags + templates, role-aware from the lease caps. (The unified
    // `runCli` intercepts this before dispatch; this branch covers the legacy
    // `/agent-api/loop` transport, which reaches `dispatch` directly.)
    if (typeof verb === "string" && verb && flags["help"] === true) {
      const h = verbHelpText(verb, lease);
      if (h) return { code: 200, text: h };
    }

    switch (verb) {
      case undefined:
      case "":
      case "-h":
      case "--help":
      case "help":
        return { code: 200, text: this.helpText(lease) };
      case "report": {
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = await store.getLoop(lease.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return derr(400, v.error, "VALIDATION_ERROR");
          state = v.value;
        }
        // F5 (fail-loud): a bad --status was previously gated into `{}` by `isStatus`
        // — the typo dropped silently, exit 0. Reject it up front instead.
        const status = str("status");
        if (status !== undefined && !isStatus(status)) {
          return derr(400, `status must be new|resolved|nothing-new (got "${status}")`, "VALIDATION_ERROR");
        }
        const message = str("message");
        await store.updateRun(lease.runId, {
          ...(status !== undefined ? { status: status as RunStatus } : {}),
          // Clipped to the same cap the report finalText fallback enforces.
          ...(message !== undefined ? { message: message.slice(0, MESSAGE_CAP) } : {}),
          ...(state !== undefined ? { state } : {}),
        });
        return { code: 200, text: renderReportedText(status, state, message !== undefined) };
      }
      case "show":
        return {
          code: 200,
          text: await this.describe(lease.loopId, { allowControl: lease.allowControl, canFinish: lease.canFinish, full: flags["full"] === true }),
        };
      case "log": {
        // The run's OWN-loop history. Batch 4 wired this into dispatch so the help
        // that advertises `log` is truthful on BOTH the unified `/api/machine/cli`
        // (runCli) AND the legacy `/agent-api/loop` transport (which reaches dispatch
        // directly). Scoped to the lease's own loop/machine — dispatch never reads a
        // loop id from flags, so a run can never target another loop (the loop-fence
        // lives in runCli for the positional-arg case).
        const res = await this.gateway.renderLoopLog(lease.machineId, lease.loopId, flags["limit"]);
        return { code: res.status, text: (res.body as { text?: string }).text ?? "" };
      }
      case "finish":
      case "complete": {
        if (!lease.canFinish) {
          // canFinish is false both for OPEN loops (no goal) and for evolve/edit
          // runs — give the right message for each. The open-loop case is primary.
          const loop = await store.getLoop(lease.loopId);
          if (!loop || loop.goal == null) {
            return derr(403, "this loop has no goal to finish (it's an open/monitor loop)", "FORBIDDEN");
          }
          return derr(403, "only an exec run may finish a loop", "FORBIDDEN");
        }
        // F5 (fail-loud): reject a bad --status here too, even though finish forces
        // status=resolved internally — a typo must never pass silently.
        const fstatus = str("status");
        if (fstatus !== undefined && !isStatus(fstatus)) {
          return derr(400, `status must be new|resolved|nothing-new (got "${fstatus}")`, "VALIDATION_ERROR");
        }
        // Optional --state, validated exactly like the report verb.
        const rawState = str("state") ?? str("state-content");
        let state: Record<string, number | string> | undefined;
        if (rawState !== undefined) {
          const loop = await store.getLoop(lease.loopId);
          const v = validateState(rawState, loop?.stateSchema ?? undefined);
          if (!v.ok) return derr(400, v.error, "VALIDATION_ERROR");
          state = v.value;
        }
        const message = str("message")?.slice(0, MESSAGE_CAP);
        const reason = str("reason")?.slice(0, MESSAGE_CAP) ?? null;
        const r = await this.gateway.finishLoop(lease, { message, reason, state });
        return r.ok ? { code: 200, text: await renderFinishedText(lease.loopId) } : derr(400, r.detail ?? "rejected", r.code);
      }
      case "set-ui": {
        if (!lease.canSetUi) return derr(403, "only the evolution or edit pass may set the UI", "FORBIDDEN");
        const html = str("body") ?? str("file-content");
        if (html === undefined) return derr(400, "set-ui needs --file <path> (shim inlines it)", "VALIDATION_ERROR");
        const r = await this.applySetUi(lease.loopId, html);
        await this.audit(lease, "set-ui", { bytes: String(html.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "ui updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
      case "set-schema": {
        if (!lease.canSetSchema) return derr(403, "only the evolution or edit pass may set the schema", "FORBIDDEN");
        const json = str("body") ?? str("file-content");
        if (json === undefined) return derr(400, "set-schema needs --file <path> (a JSON array of {key,label,unit})", "VALIDATION_ERROR");
        const r = await this.applySetSchema(lease.loopId, json);
        await this.audit(lease, "set-schema", { bytes: String(json.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "schema updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
      case "set-workflow": {
        if (!lease.canSetWorkflow) return derr(403, "only the evolution or edit pass may set the workflow", "FORBIDDEN");
        const body = str("body") ?? str("file-content");
        if (!body) return derr(400, "set-workflow needs --file <path> (shim inlines it)", "VALIDATION_ERROR");
        const r = await this.applySetWorkflow(lease.loopId, body);
        await this.audit(lease, "set-workflow", { bytes: String(body.length) }, r);
        return r.ok ? { code: 200, text: r.detail ?? "workflow updated" } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
      }
    }

    if (MUTATION_VERBS.has(verb ?? "")) {
      if (!lease.allowControl) return derr(403, "this loop may not change its own schedule (allowControl is off)", "FORBIDDEN");
      const r = await this.applyMutation(lease.loopId, verb!, flags, str);
      await this.audit(lease, verb!, stringifyFlags(flags), r);
      return r.ok ? { code: 200, text: r.detail ?? `${verb} applied` } : derr(400, r.detail ?? "rejected", "VALIDATION_ERROR");
    }
    return derr(400, `unknown command "${verb ?? ""}" (try: loopany help)`, "VALIDATION_ERROR");
  }

  /** Usage for `loopany help` / `--help` / a bare invocation, rendered as the §4.9
   *  axi TOON: grouped verbs with an availability tag reflecting THIS lease's caps
   *  (always / finish / dashboard-gate / schedule), then a trailing `help[]`. Still
   *  role-aware — the tags flip with the lease's role + caps, so the agent never
   *  wastes a turn probing a verb it'll be 403'd on. */
  private helpText(lease: RunLease): string {
    const finishTag = lease.canFinish
      ? "available — declare the goal met (--message <achieved> [--reason <one line>])"
      : `exec run on a goal (closed) loop only — this run is "${lease.role}"`;
    const structural = lease.canSetUi ? "available to this run" : `evolve/edit pass only — this run is "${lease.role}"`;
    const control = lease.allowControl ? "available to this run" : "needs allowControl (off for this loop)";

    // The `always` group is a typed list; indent every line two spaces to nest it
    // under the `verbs:` top key (matching the reference tool's nested shape).
    const always = indent(
      listBlock("always", ["verb", "syntax"], [
        ["report", "[--status new|resolved|nothing-new] [--message <s>] [--state '{\"k\":n}' | --state-file <p>]"],
        ["show", "print this loop's config + recent state"],
        ["log", "recent run survey for this loop"],
      ]),
    );
    // The schedule group is a typed list whose HEADER carries the availability tag
    // (a list header with a trailing tag, per §4.9). Build the header by hand so the
    // tag rides after the `{…}:` and indent the whole block under `verbs:`.
    const scheduleRows: Scalar[][] = [
      ["reschedule", "--run-at <30m|2h|ISO>   one extra run soon, then resume cadence"],
      ["set-cron", '"<5-field cron>"   change the cadence (floor applies)'],
      ["pause/resume", "toggle this loop"],
      ["notify", "always|auto|never · set-name/-tz/-model"],
    ];
    const schedule = indent(
      [
        `schedule[${scheduleRows.length}]{verb,syntax}: ${control}`,
        ...scheduleRows.map((r) => `  ${r.map(scalar).join(",")}`),
      ].join("\n"),
    );
    return doc(
      "verbs:",
      always,
      `  finish: ${finishTag}`,
      `  dashboard/gate: ${structural}`,
      schedule,
      helpBlock([
        "Run `loopany show` to read the current config before changing it",
        "Run `loopany report --status nothing-new` to close this run with no news",
      ]),
    );
  }

  private async applyMutation(loopId: string, verb: string, flags: Flags, str: (k: string) => string | undefined): Promise<Applied> {
    switch (verb) {
      case "reschedule": {
        // F4: `--run-at` is canonical (aligns with the `runAt` edit key + the help
        // text); `--next` is kept as a working back-compat alias so existing
        // prompts/scripts don't break. Both drive the same pinned one-shot next fire.
        const raw = str("run-at") ?? str("next");
        const when = raw ? parseWhen(raw) : undefined;
        if (!when) return { ok: false, detail: `reschedule needs --run-at <30m|2h|ISO>` };
        if (Date.parse(when) > Date.now() + MAX_NEXT_MS) return { ok: false, detail: "too far in the future (>30d)" };
        // Self-schedule floor (RUN path only; the owner's edit path is unlimited): a
        // run may not schedule itself sooner than the reschedule floor.
        const floorMin = selfRescheduleFloorMinutes();
        if (Date.parse(when) - Date.now() < floorMin * 60_000) {
          return { ok: false, detail: `a run can't reschedule sooner than ${floorMin} min out — the owner can set any time via edit` };
        }
        const loop = await store.updateLoop(loopId, { nextRunAt: when });
        if (loop) this.gateway.scheduler.addLoop(loop);
        return { ok: true, detail: `next run at ${new Date(when).toLocaleString()}` };
      }
      case "set-cron": {
        const cron = str("_") ?? str("cron");
        if (!cron) return { ok: false, detail: 'set-cron needs the expression, e.g. set-cron "*/30 * * * *"' };
        const tz = (await store.getLoop(loopId))?.timezone;
        const c = validCadence(cron, tz);
        if (!c.ok) return c;
        // Self-schedule floor (RUN path only; owner's edit path is unlimited): a run
        // may not set a cron whose adjacent fires (probed in the loop's tz, like
        // validCadence) are closer than the cron floor.
        const floorMin = selfCronFloorMinutes();
        const interval = cronIntervalMs(cron, tz);
        if (interval !== null && interval < floorMin * 60_000) {
          return {
            ok: false,
            detail: `a run can't schedule more often than every ${floorMin} min (that cron fires every ~${Math.round(interval / 60_000)} min) — the owner can set any cadence via edit`,
          };
        }
        const loop = await store.updateLoop(loopId, { cron });
        if (loop) this.gateway.scheduler.addLoop(loop);
        return { ok: true, detail: `cron set to "${cron}"` };
      }
      case "pause":
      case "resume": {
        const enabled = verb === "resume";
        const loop = await store.updateLoop(loopId, { enabled });
        if (loop) enabled ? this.gateway.scheduler.addLoop(loop) : this.gateway.scheduler.removeLoop(loopId);
        return { ok: true, detail: enabled ? "resumed" : "paused" };
      }
      case "notify": {
        const v = (str("_") ?? str("notify")) as NotifyPolicy | undefined;
        if (v !== "always" && v !== "auto" && v !== "never") return { ok: false, detail: "notify needs always|auto|never" };
        await store.updateLoop(loopId, { notify: v });
        return { ok: true, detail: `notify set to ${v}` };
      }
      case "set-name": {
        const name = (str("_") ?? str("name"))?.trim() || null;
        await store.updateLoop(loopId, { name });
        return { ok: true, detail: name ? `name set to "${name}"` : "name cleared" };
      }
      case "set-tz": {
        const tz = (str("_") ?? str("tz") ?? str("timezone"))?.trim() || null;
        if (tz && !validTimezone(tz)) return { ok: false, detail: invalidTimezoneError(tz) };
        const loop = await store.updateLoop(loopId, { timezone: tz });
        if (loop) this.gateway.scheduler.addLoop(loop); // tz changes the cron's interpretation
        return { ok: true, detail: tz ? `timezone set to ${tz}` : "timezone cleared (server-local)" };
      }
      case "set-model": {
        const model = (str("_") ?? str("model"))?.trim() || null;
        await store.updateLoop(loopId, { model });
        return { ok: true, detail: model ? `model set to ${model}` : "model cleared" };
      }
      default:
        return { ok: false, detail: `unhandled verb ${verb}` };
    }
  }

  // The set-* apply paths reuse the SAME `validate.ts` validators the owner
  // device-token createLoop/editLoop path imports, so the two surfaces validate
  // identically and can't drift (the anti-drift invariant lives in validate.ts).

  private async applySetUi(loopId: string, html: string): Promise<Applied> {
    const { value: ui } = validateUi(html);
    const loop = await store.updateLoop(loopId, { ui });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: ui ? `ui updated (${ui.length} bytes)` : "ui cleared" };
  }

  private async applySetWorkflow(loopId: string, body: string): Promise<Applied> {
    const v = validateWorkflow(body);
    if (!v.ok) return { ok: false, detail: v.detail };
    const loop = await store.updateLoop(loopId, { workflow: v.value });
    if (!loop) return { ok: false, detail: "loop not found" };
    return { ok: true, detail: loop.workflow ? `workflow updated (${loop.workflow.length} bytes)` : "workflow cleared" };
  }

  private async applySetSchema(loopId: string, json: string): Promise<Applied> {
    const v = await validateSchema(loopId, json);
    if (!v.ok) return { ok: false, detail: v.detail };
    await store.updateLoop(loopId, { stateSchema: v.value });
    return { ok: true, detail: `schema set (${v.value.map((f) => f.key).join(", ")})` };
  }

  // The full editable envelope (F1/F6, §4.1 batch 2): every EDITABLE_LOOP_FIELDS key
  // keyed EXACTLY as `edit --json` accepts, PLUS the read-only derived aggregates
  // (nextFire/classification/runs). Large content (ui/workflow) shows a presence+size
  // hint by default and inlines under `--full`; stateSchema renders structurally.
  //
  // `opts.allowControl`/`opts.canFinish` are a RUN caller's EFFECTIVE capabilities
  // (the run lease's `structural || loop.allowControl`, and the exec-on-closed-loop
  // finish gate); when present the run adds the `selfSchedule`/`selfFinish` effective
  // lines and run-appropriate help. A device caller passes neither and gets the
  // owner-facing help (edit/log). `--json` is emitted by the callers, not here.
  private async describe(loopId: string, opts: { allowControl?: boolean; canFinish?: boolean; full?: boolean } = {}): Promise<string> {
    const loop = await store.getLoop(loopId);
    if (!loop) return "loop not found";
    // The most recent exec run (newest-first) anchors the `runs:` tally's last-outcome.
    const recent = (await store.listRuns(loop.id, LOG_RUNS_DEFAULT)).slice().reverse();
    const lastExec = recent.find((r) => r.role === "exec") ?? null;
    return renderShowText(loop, loopEnvelope(loop), await store.countRuns(loop.id), lastExec, opts);
  }

  /**
   * `loopany` (bare) — the content-first home for a DEVICE credential (P8/§5.1). The
   * daemon passes the local facts it alone knows as context flags (`--cwd`/`--home`
   * for directory scoping, `--bin`/`--pid`/`--server` for the header); the server owns
   * the whole TOON render (text-sink). An unregistered machine renders a DEFINITIVE
   * "not connected" state (never empty, never an error). This same text is what the
   * SessionStart hook emits every session, so it self-heals when a machine is asleep.
   */
  private async homeDevice(machineId: string, flags: Flags): Promise<string> {
    const machine = await store.getMachine(machineId);
    const ctx: HomeContext = {
      bin: typeof flags["bin"] === "string" ? (flags["bin"] as string) : null,
      pid: typeof flags["pid"] === "string" ? (flags["pid"] as string) : null,
      server: typeof flags["server"] === "string" ? (flags["server"] as string) : null,
      cwd: typeof flags["cwd"] === "string" ? (flags["cwd"] as string) : null,
      home: typeof flags["home"] === "string" ? (flags["home"] as string) : null,
    };
    if (!machine) return renderHomeText(ctx, null, [], 0, []);
    const presence = machinePresence(machine.online, machine.lastSeen);
    const loops = await store.loopsForMachine(machineId);
    const scoped = scopeLoopsByCwd(loops, ctx.cwd, ctx.home);
    const here: HomeLoop[] = await Promise.all(
      scoped.here.map(async (l) => ({
        id: l.id,
        name: l.name ?? l.id,
        cron: l.cron,
        enabled: l.enabled,
        nextFire: l.enabled ? (nextFires(l.cron, l.timezone, 1)[0] ?? null) : null,
        lastOutcome: await (async () => {
          const last = await store.lastExecRun(l.id);
          return last ? runOutcomeToken(last) : null;
        })(),
      })),
    );
    return renderHomeText(ctx, presence, here, scoped.elsewhere, await recentMachineRuns(loops, 3));
  }

  /** `loopany` (bare) inside a run — the RUN credential's own-loop home (§5.1). */
  private async homeRun(lease: RunLease): Promise<string> {
    const loop = await store.getLoop(lease.loopId);
    if (!loop) return errorBlock("loop not found", "NOT_FOUND");
    const recent = (await store.listRuns(loop.id, 2)).slice().reverse().map((r) => ({
      ts: r.ts,
      outcome: runOutcomeToken(r),
      message: r.message ?? null,
    }));
    return renderRunHomeText(loop.name ?? loop.id, loop.id, lease.role, loop.goal ?? null, recent);
  }

  private async audit(lease: RunLease, command: string, args: Record<string, string>, r: Applied): Promise<void> {
    const run = await store.getRun(lease.runId);
    const control: ControlAction[] = [
      ...((run?.control as ControlAction[] | null | undefined) ?? []),
      {
        ts: nowIso(),
        command,
        args,
        result: r.ok ? "ok" : "rejected",
        detail: r.detail,
      },
    ];
    await store.updateRun(lease.runId, { control });
  }
}

// ---- helpers (ported from control.ts) ----

type Flags = Record<string, string | boolean>;

const MUTATION_VERBS = new Set(["reschedule", "set-cron", "pause", "resume", "notify", "set-name", "set-tz", "set-model"]);

/** The one message for a reclaimed (terminal-grace) run's refused CLI mutation —
 *  shared by `agentApi` + `runCli` so the two transports can't drift. */
const RECLAIMED_MSG =
  "this run was reclaimed by the server (the machine was likely asleep); its result is delivered via the final report";

/** Verbs that require OWNER (device) authority — a run credential is 403'd on these
 *  in the unified `cli` dispatch (§4.1). `report`/`finish` are the mirror image
 *  (run-only, 403 for a device credential) and are handled inline in `deviceCli`. */
const DEVICE_ONLY_VERBS = new Set(["new", "edit", "loops", "status"]);

/** Parse a `--json '<obj>'` flag into an object. Absent → an empty object (the
 *  downstream createLoop/editLoop validators then produce the precise error, e.g.
 *  "cron required"). Present-but-not-a-JSON-object → a legible 400. Shared by the
 *  device-credential `new`/`edit` verbs of the unified CLI. */
function parseJsonFlag(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === true) return { ok: true, value: {} };
  if (typeof raw !== "string") return { ok: false, error: "loopany: --json must be a JSON object string" };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "loopany: --json must be valid JSON (an object)" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "loopany: --json must be a JSON object" };
  return { ok: true, value: obj as Record<string, unknown> };
}

function stringifyFlags(flags: Flags): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) out[k] = String(v);
  return out;
}

/** A structured error result to STDOUT (P6): `error:`/`code:` TOON as the verb `text`.
 *  Mirrors the `{code, text}` shape `dispatch` returns; the slug defaults from the
 *  HTTP status but a caller may pin it (e.g. CONFLICT). */
function derr(code: number, message: string, slug?: string): { code: number; text: string } {
  return { code, text: errorBlock(message, slug ?? codeForStatus(code)) };
}

/** The ONLY structured keys a `/api/machine/cli` body carries after Batch 7. The daemon
 *  is a pure text sink — it renders `text` (+ exits `exitCode`) for every verb — so the
 *  transitional "superset" render fields (`ok`/`id`/`loop`/`changes`/`config`/… that let
 *  a pre-0.12 daemon render structured, design §3) are RETIRED at this boundary. Two
 *  structured channels survive because the current daemon reads them as DATA, not to
 *  render:
 *   - `loops`: the daemon resolves cwd→loop CLIENT-side (`log`/`show`/`home`) from this
 *     list — the server's `log`/`show` dispatch needs an explicit id (design §3).
 *   - `runs`: the `log --json` escape hatch (OQ4, permanent) and the `log --transcript`
 *     inline render read the structured runs — the server survey `text` stays concise.
 *  The LEGACY endpoints (`/api/machine/loop|log`, `/agent-api/loop`) do NOT pass through
 *  `finalizeCli`, so their full structured bodies are unchanged (a pre-0.12 daemon on the
 *  postCli 404-fallback still renders — retired separately, its own upgrade-window gate). */
const CLI_RETAINED_KEYS = new Set(["text", "exitCode", "loops", "runs"]);

/** Finalize a `/api/machine/cli` body: ensure it carries `text` + `exitCode` (P1/P6) and
 *  strip every non-retained structured field (Batch 7 — retire the superset scaffolding).
 *  A structured `{error}` (createLoop/editLoop validation, the deviceCli denials) is first
 *  rendered to `error:`/`code:` TOON so the daemon prints it to stdout. */
function finalizeCli(res: HttpResult): HttpResult {
  const b = res.body;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const body = b as Record<string, unknown>;
    if (typeof body.text !== "string" && typeof body.error === "string") {
      body.text = errorBlock(body.error, codeForStatus(res.status));
    }
    if (typeof body.exitCode !== "number") {
      body.exitCode = res.status >= 200 && res.status < 300 ? 0 : 1;
    }
    // Drop the retired render-only fields, but only once a `text` render exists (every
    // cli path either renders `text` or set `error` above → text is now present; the
    // guard is defensive so a hypothetical text-less body is never silently blanked).
    if (typeof body.text === "string") {
      for (const k of Object.keys(body)) if (!CLI_RETAINED_KEYS.has(k)) delete body[k];
    }
  }
  return res;
}

/** `loopany report` — the compact run-outcome confirmation (§4.6). */
function renderReportedText(status: string | undefined, state: Record<string, number | string> | undefined, hasMessage: boolean): string {
  const parts: string[] = [];
  if (status) parts.push(`status=${status}`);
  const metrics = runMetricsToken(state);
  if (metrics) parts.push(`metrics ${metrics}`);
  if (hasMessage) parts.push("message recorded");
  return `reported: ${parts.length ? parts.join(" · ") : "recorded"}`;
}

/** `loopany finish` — the goal-met confirmation, read back off the completed loop. */
async function renderFinishedText(loopId: string): Promise<string> {
  const loop = await store.getLoop(loopId);
  if (!loop) return "finished: goal met";
  return doc(
    `finished: ${scalar(loop.name ?? loop.id)} (${loop.id}) — goal met`,
    loop.completedAt ? kvLine("completedAt", fmtTime(loop.completedAt)) : null,
    loop.completionReason ? kvLine("completionReason", loop.completionReason) : null,
  );
}

/** Indent every line of a rendered TOON block two spaces, so a typed list/detail
 *  nests under a parent top key (e.g. the `always[]`/`schedule[]` groups under
 *  `verbs:` in the in-run help). */
function indent(block: string): string {
  return block
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

// ---- per-verb `--help` (P10) --------------------------------------------------
// `<verb> --help` prints that verb's syntax + a one-line summary + concrete `help[]`
// templates. Rendered server-side so it is ROLE-AWARE for a run credential (the lease
// caps decide the availability line) and full for a device credential (owner
// authority, no availability caveats). Two maps because the run + owner verb surfaces
// barely overlap (`show`/`log` differ by scope); a verb absent from the relevant map
// has no `--help` and falls through to the caller's unknown-command handling.

interface VerbHelpSpec {
  syntax: string;
  summary: string;
  help: string[];
  /** Availability line for a RUN lease (role-aware); omitted ⇒ no availability line. */
  avail?: (lease: RunLease) => string;
}

/** Availability of a schedule/control mutation for a run: gated by `allowControl`. */
const controlAvail = (l: RunLease): string => (l.allowControl ? "available to this run" : "needs allowControl (off for this loop)");
/** Availability of a structural (set-ui/schema/workflow) verb: evolve/edit pass only. */
const gateAvail = (has: (l: RunLease) => boolean | undefined) => (l: RunLease): string =>
  has(l) ? "available to this run (evolve/edit pass)" : `evolve/edit pass only — this run is "${l.role}"`;
const alwaysAvail = (): string => "always available";

/** RUN-credential verb help (in-run `rk_` lease). */
const RUN_VERB_HELP: Record<string, VerbHelpSpec> = {
  report: {
    syntax: "report [--status new|resolved|nothing-new] [--message <s>] [--state '{\"k\":n}' | --state-file <path>]",
    summary: "record this run's outcome + metrics (state keys must match the loop's schema)",
    avail: alwaysAvail,
    help: [
      "Run `loopany report --status nothing-new` to close this run with no news",
      'Run `loopany report --status new --message "<one line>" --state \'{"drift":3}\'` to record metrics',
    ],
  },
  finish: {
    syntax: 'finish --message "<achieved>" [--reason "<one line>"]',
    summary: "declare the goal met — completes this closed loop",
    avail: (l) => (l.canFinish ? "available — declare the goal met" : `exec run on a goal (closed) loop only — this run is "${l.role}"`),
    help: ['Run `loopany finish --message "<what was achieved>" --reason "<one line>"` to complete the loop'],
  },
  show: {
    syntax: "show",
    summary: "print this loop's current config + recent state",
    avail: alwaysAvail,
    help: ["Run `loopany log` to see this loop's recent runs"],
  },
  log: {
    syntax: "log [--limit <n>] [--transcript] [--json]",
    summary: "recent run survey for this loop (session ids + metrics)",
    avail: alwaysAvail,
    help: ["Run `loopany log --transcript` to inline each run's transcript"],
  },
  reschedule: {
    syntax: "reschedule --run-at <30m|2h|ISO>",
    summary: "run once more soon, then resume the cadence (floor applies; --next is an alias)",
    avail: controlAvail,
    help: ["Run `loopany reschedule --run-at 2h` to run again in two hours"],
  },
  "set-cron": {
    syntax: 'set-cron "<5-field cron>"',
    summary: "change the cadence (floor applies)",
    avail: controlAvail,
    help: ['Run `loopany set-cron "0 7 * * 1"` to change the cadence'],
  },
  "set-ui": {
    syntax: "set-ui --file <path>",
    summary: "replace the dashboard HTML (the shim inlines the file)",
    avail: gateAvail((l) => l.canSetUi),
    help: ["Run `loopany set-ui --file dashboard.html` to replace the dashboard"],
  },
  "set-schema": {
    syntax: "set-schema --file <path>",
    summary: "declare metrics — a JSON array of {key, label?, unit?}",
    avail: gateAvail((l) => l.canSetSchema),
    help: ["Run `loopany set-schema --file schema.json` to declare the loop's metrics"],
  },
  "set-workflow": {
    syntax: "set-workflow --file <path>",
    summary: "replace the deterministic pre-stage JS",
    avail: gateAvail((l) => l.canSetWorkflow),
    help: ["Run `loopany set-workflow --file workflow.js` to replace the pre-stage"],
  },
  pause: {
    syntax: "pause",
    summary: "pause this loop (enabled=false)",
    avail: controlAvail,
    help: ["Run `loopany resume` to re-enable it"],
  },
  resume: {
    syntax: "resume",
    summary: "resume this loop (enabled=true)",
    avail: controlAvail,
    help: ["Run `loopany pause` to pause it again"],
  },
  notify: {
    syntax: "notify always|auto|never",
    summary: "set this loop's failure/success notification policy",
    avail: controlAvail,
    help: ["Run `loopany notify auto` to notify only on meaningful changes"],
  },
  "set-name": {
    syntax: 'set-name "<name>"',
    summary: "rename this loop",
    avail: controlAvail,
    help: ['Run `loopany set-name "Docs Sweep"` to rename the loop'],
  },
  "set-tz": {
    syntax: "set-tz <IANA zone>",
    summary: "set the loop's timezone (the cron fires in it)",
    avail: controlAvail,
    help: ["Run `loopany set-tz America/Los_Angeles` to change the timezone"],
  },
  "set-model": {
    syntax: "set-model <model>",
    summary: "pin the coding-agent model for this loop",
    avail: controlAvail,
    help: ["Run `loopany set-model claude-opus-4-8` to pin the model"],
  },
};
// `complete` is a documented alias of `finish` (§6.2).
RUN_VERB_HELP.complete = RUN_VERB_HELP.finish!;

/** DEVICE-credential verb help (owner `dk_` device token). */
const DEVICE_VERB_HELP: Record<string, VerbHelpSpec> = {
  new: {
    syntax: "new --json '<config>' [--dry-run]",
    summary: `create a loop (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")}; cron + taskFile|workflow required)`,
    help: [
      "Run `loopany new --json '{\"cron\":\"0 8 * * *\",\"taskFile\":\"<path>\"}'` to create a loop",
      "Run `loopany new --json '{...}' --dry-run` to validate without creating",
    ],
  },
  loops: {
    syntax: "loops",
    summary: "list every loop bound to this machine",
    help: ["Run `loopany show <id>` to see a loop's full config", "Run `loopany log <id>` to see a loop's recent runs"],
  },
  edit: {
    syntax: "edit <id> --json '<patch>' [--dry-run]",
    summary: `change a loop's config (keys: ${[...EDITABLE_LOOP_FIELDS].join(", ")})`,
    help: [
      "Run `loopany edit <id> --json '{\"cron\":\"0 7 * * 1\"}'` to change the schedule",
      "Run `loopany edit <id> --json '{...}' --dry-run` to preview the change",
    ],
  },
  show: {
    syntax: "show <id>",
    summary: "print a loop's full config + recent state",
    help: ["Run `loopany loops` to list loops on this machine", "Run `loopany log <id>` to see the loop's recent runs"],
  },
  log: {
    syntax: "log [<id>] [--limit <n>] [--transcript] [--json]",
    summary: "recent run survey for a loop (session ids + metrics)",
    help: ["Run `loopany log <id> --transcript` to inline each run's transcript", "Run `loopany log <id> --json` for the structured run rows"],
  },
};

/** Render a verb's `--help` (P10). A run lease ⇒ role-aware (availability line from
 *  the caps); no lease ⇒ the device (owner) surface. Returns undefined for a verb
 *  with no help spec, so the caller falls back to its unknown-command handling. */
function verbHelpText(verb: string, lease?: RunLease): string | undefined {
  const spec = lease ? RUN_VERB_HELP[verb] : DEVICE_VERB_HELP[verb];
  if (!spec) return undefined;
  return doc(
    kvLine("verb", verb),
    kvLine("syntax", spec.syntax),
    kvLine("summary", spec.summary),
    lease && spec.avail ? kvLine("availability", spec.avail(lease)) : null,
    helpBlock(spec.help),
  );
}

/**
 * The full editable envelope keyed EXACTLY as `edit --json` accepts (read/write
 * identity, F6/§4.1 batch 2): `id` + every EDITABLE_LOOP_FIELDS key with its raw
 * stored value (full bodies, no truncation). `show --json` emits this verbatim;
 * dropping `id` yields a no-op `edit` patch (pinned by the roundtrip test). The
 * pinned next-run OVERRIDE is keyed `runAt` (matching the edit key; the DB column
 * stays `nextRunAt`), NOT the derived read-only `nextFire` aggregate.
 */
function loopEnvelope(loop: Loop): Record<string, unknown> {
  return {
    id: loop.id,
    name: loop.name ?? null,
    cron: loop.cron,
    timezone: loop.timezone ?? null,
    notify: loop.notify,
    model: loop.model ?? null,
    allowControl: loop.allowControl,
    taskFile: loop.taskFile ?? null,
    enabled: loop.enabled,
    runAt: loop.nextRunAt ?? null,
    goal: loop.goal ?? null,
    workflow: loop.workflow ?? null,
    ui: loop.ui ?? null,
    stateSchema: loop.stateSchema ?? null,
  };
}

/** Render a large content field (ui/workflow) for the `show` detail block: `absent`
 *  when unset, the full body (scalar-quoted) under `--full`, else a presence + size
 *  hint (P3 / feedback #2 — never a char-clipped body). */
function contentField(value: string | null, full: boolean): Scalar | { raw: string } {
  if (value == null) return "absent";
  if (full) return value; // scalar() quotes the full body (newlines escaped to one line)
  return { raw: `present, ${value.length} bytes — use --full to see` };
}

/** Render the state schema STRUCTURALLY (not char-clipped): the header
 *  `stateSchema[N]{key,label,unit}:` plus one `key,label,unit` triple per field,
 *  joined by ` · `. Absent → the bare `absent` token. */
function schemaField(schema: StateField[] | null): { key: string; value: Scalar | { raw: string } } {
  if (!schema || !schema.length) return { key: "stateSchema", value: "absent" };
  const rows = schema.map((f) => [f.key, f.label ?? ABSENT, f.unit ?? ABSENT].join(",")).join(" · ");
  return { key: `stateSchema[${schema.length}]{key,label,unit}`, value: { raw: rows } };
}

/** The next cadence fire (the derived read-only aggregate), formatted in the loop's
 *  OWN timezone with a short zone name (`2026-07-13 06:00:00 PDT`) — matching how the
 *  scheduler arms it. Distinct from the writable `runAt` override (F4). */
function nextFireDisplay(cron: string, timezone: string | null): string {
  const iso = nextFires(cron, timezone, 1)[0];
  if (!iso) return "(never)";
  return fmtTimeZoned(iso, timezone, { seconds: true });
}

/**
 * `loopany show` — the full editable envelope TOON (F1/F6, feedback #1/#2, §4.1).
 * The `loop:` block keys are EXACTLY `edit --json`'s keys (read/write identity),
 * then the read-only derived aggregates (`nextFire`/`classification`/`runs`). A run
 * caller (opts.allowControl/canFinish present) adds the effective `selfSchedule`/
 * `selfFinish` lines + run-appropriate help; a device caller gets owner help.
 */
function renderShowText(
  loop: Loop,
  env: Record<string, unknown>,
  totalRuns: number,
  lastExec: { phase: string; outcome: string | null; status: string | null; ts: string } | null,
  opts: { allowControl?: boolean; canFinish?: boolean; full?: boolean } = {},
): string {
  const full = opts.full === true;
  const schema = schemaField(loop.stateSchema ?? null);
  const block = detailBlock("loop", [
    ["id", env.id as Scalar],
    ["name", env.name as Scalar],
    ["cron", env.cron as Scalar],
    ["timezone", env.timezone as Scalar],
    ["notify", env.notify as Scalar],
    ["model", env.model as Scalar],
    ["allowControl", env.allowControl as Scalar],
    ["taskFile", env.taskFile as Scalar],
    ["enabled", env.enabled as Scalar],
    ["runAt", env.runAt as Scalar],
    // The setpoint: a value ⇒ CLOSED loop (finishable); em-dash ⇒ OPEN (monitor).
    ["goal", env.goal as Scalar],
    ["workflow", contentField(loop.workflow ?? null, full)],
    ["ui", contentField(loop.ui ?? null, full)],
    [schema.key, schema.value],
  ]);
  const classification =
    loop.goal != null
      ? "closed (has goal — self-finishes when the goal is met)"
      : "open (no goal — runs until paused)";
  const runsTally = lastExec
    ? `${totalRuns} total · last exec ${runOutcomeToken(lastExec)} ${fmtTime(lastExec.ts)}`
    : `${totalRuns} total`;
  // A run caller reads its EFFECTIVE capabilities; a device caller (both undefined)
  // omits these and gets the owner help below.
  const isRun = opts.allowControl !== undefined || opts.canFinish !== undefined;
  const help = isRun
    ? [
        "Run `loopany reschedule --run-at 2h` to run again sooner (then resume cadence)",
        `Run \`loopany set-cron "${loop.cron}"\` to change the cadence (floors apply)`,
        'Run `loopany report --status new --message "<one line>"` to record this run',
      ]
    : [
        `Run \`loopany show ${loop.id} --full\` to see the complete ui/workflow bodies`,
        `Run \`loopany edit ${loop.id} --json '{"cron":"0 7 * * 1"}'\` to change the schedule`,
        `Run \`loopany log ${loop.id}\` to see recent run outcomes`,
      ];
  return doc(
    block,
    kvLine("nextFire", nextFireDisplay(loop.cron, loop.timezone ?? null)),
    `classification: ${classification}`,
    `runs: ${runsTally}`,
    // EFFECTIVE run capabilities (camelCase, replacing the old self-schedule/
    // self-finish display keys): whether this run may self-reschedule, and whether it
    // may declare the goal met (exec-on-closed-loop).
    opts.allowControl !== undefined ? kvLine("selfSchedule", opts.allowControl ? "allowed" : "off") : null,
    opts.canFinish !== undefined ? kvLine("selfFinish", opts.canFinish ? "allowed" : "off") : null,
    helpBlock(help),
  );
}

// ---- content-first home (P8/§5.1) --------------------------------------------
// Bare `loopany` renders a live machine dashboard (device) or the run's own-loop
// context (run). The server owns the whole TOON render (text-sink); the daemon
// passes the local facts it alone knows (`--bin`/`--pid`/`--server`/`--cwd`/`--home`)
// as context flags. Everything below is pure so it's exercised in the verb tests.

/** The daemon-supplied local context for the device home header + cwd scoping. */
interface HomeContext {
  bin: string | null;
  pid: string | null;
  server: string | null;
  cwd: string | null;
  home: string | null;
}

/** One loop row in the device home (a minimal, scan-friendly subset of `loops`). */
interface HomeLoop {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextFire: string | null;
  lastOutcome: string | null;
}

/** The static one-line description in the home header (mirrors the reference axi
 *  tools' `description:` line — what this bin is for). */
const HOME_DESCRIPTION = "Run your scheduled Loopany agent loops on this machine with your own coding agent.";

/** Expand a leading `~/` against the daemon-supplied home dir (the SERVER's own home
 *  is irrelevant — a loop's paths are the daemon machine's). Absent home ⇒ unchanged. */
function expandHome(p: string, home: string | null): string {
  return home && p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** A loop's folder on the daemon machine — mirrors the daemon's `resolveLoopDir`
 *  (dirname(taskFile) → workdir), minus the scratch fallback (which never matches a
 *  real cwd). Returns null when neither path is known (⇒ never "here"). */
function scopeLoopDir(workdir: string | null, taskFile: string | null, home: string | null): string | null {
  if (taskFile) {
    const tf = expandHome(taskFile, home);
    if (path.isAbsolute(tf)) return path.dirname(path.resolve(tf));
    if (workdir) return path.dirname(path.resolve(expandHome(workdir, home), tf));
  }
  if (workdir) return path.resolve(expandHome(workdir, home));
  return null;
}

/**
 * Partition a machine's loops into the ones rooted at (or under) `cwd` — the
 * directory-scoped ambient context P8 wants — and a count of the rest. With no cwd
 * (or none matching), ALL loops are "here" (elsewhere 0): a home run from an
 * unrelated directory still shows the whole machine rather than nothing.
 */
export function scopeLoopsByCwd(
  loops: Loop[],
  cwd: string | null,
  home: string | null,
): { here: Loop[]; elsewhere: number } {
  if (!cwd) return { here: loops, elsewhere: 0 };
  const here = path.resolve(cwd);
  const matched = loops.filter((l) => {
    const dir = scopeLoopDir(l.workdir ?? null, l.taskFile ?? null, home);
    return dir !== null && (here === dir || here.startsWith(dir + path.sep));
  });
  if (matched.length === 0) return { here: loops, elsewhere: 0 };
  return { here: matched, elsewhere: loops.length - matched.length };
}

/** The most recent runs across ALL of a machine's loops, newest-first, for the home
 *  `recent[]` block. Merges each loop's newest few then globally sorts by ts. */
async function recentMachineRuns(loops: Loop[], n: number): Promise<Array<{ ts: string; loop: string; outcome: string }>> {
  const rows: Array<{ ts: string; loop: string; outcome: string }> = [];
  for (const l of loops) {
    for (const r of await store.listRuns(l.id, n)) {
      rows.push({ ts: r.ts, loop: l.name ?? l.id, outcome: runOutcomeToken(r) });
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, n);
}

/** The device home (P8/§5.1): `bin:`/`description:`/`machine:` header, the cwd-scoped
 *  loop list, recent runs, and a `help[]`. `presence` null ⇒ the machine is not
 *  registered → a DEFINITIVE "not connected" state (never empty, never an error). */
function renderHomeText(
  ctx: HomeContext,
  presence: MachinePresence | null,
  here: HomeLoop[],
  elsewhere: number,
  recent: Array<{ ts: string; loop: string; outcome: string }>,
): string {
  const machineLine =
    presence === null
      ? "machine: not connected — run `loopany up`"
      : `machine: ${[presence, ctx.pid ? `daemon pid ${ctx.pid}` : null, ctx.server].filter(Boolean).join(" · ")}`;
  // P8 requires the home to LEAD with `bin:` (every reference axi tool does). The daemon
  // sends the durable path via `--bin` when it has one; absent (npx-without-global), we
  // render the honest fallback so the line is NEVER missing (F7).
  const binLineText = ctx.bin ? kvLine("bin", ctx.bin) : "bin: (not on PATH — run `npm i -g @crewlet/loopany`)";
  // Not connected: the header + the definitive state + how to connect. No loop/run
  // blocks (there's nothing to show), but never empty output (P5/P8).
  if (presence === null) {
    return doc(
      binLineText,
      kvLine("description", HOME_DESCRIPTION),
      machineLine,
      helpBlock([
        "Run `loopany up --server-url <url> --connect-key <dk_…>` to connect this machine",
        "Run `loopany --help` to see every command",
      ]),
    );
  }
  // Header wording (F11, §5.1): when the list is cwd-SCOPED (some loops live elsewhere)
  // the block is `loops here[N]` — the "here" only makes sense against an "elsewhere".
  // An unscoped full-machine view stays the plain `loops[N]`.
  const loopsName = elsewhere > 0 ? "loops here" : "loops";
  const loopsBlock = here.length
    ? listBlock(
        loopsName,
        ["name", "cron", "enabled", "nextFire", "lastOutcome"],
        here.map((l) => [l.name, l.cron, l.enabled ? "on" : "paused", l.nextFire ? fmtTime(l.nextFire) : null, l.lastOutcome]),
      )
    : emptyList(loopsName);
  const recentBlock = recent.length
    ? listBlock("recent", ["ts", "loop", "outcome"], recent.map((r) => [fmtTime(r.ts), r.loop, r.outcome]))
    : null;
  return doc(
    binLineText,
    kvLine("description", HOME_DESCRIPTION),
    machineLine,
    loopsBlock,
    elsewhere > 0 ? `loops elsewhere: ${elsewhere} more on this machine` : null,
    recentBlock,
    helpBlock([
      "Run `loopany loops` to list every loop on this machine",
      "Run `loopany show <id>` to inspect a loop, `loopany log <id>` for its runs",
      "Run `loopany new --json '{...}'` to create a loop",
    ]),
  );
}

/** The run-credential home (§5.1): the run's own loop identity + role + goal, its
 *  recent runs, and run-appropriate help — scoped to the lease's loop. */
function renderRunHomeText(
  name: string,
  loopId: string,
  role: RunRole,
  goal: string | null,
  recent: Array<{ ts: string; outcome: string; message: string | null }>,
): string {
  const recentBlock = recent.length
    ? listBlock(
        "recent",
        ["ts", "outcome", "message"],
        recent.map((r) => [fmtTime(r.ts), r.outcome, r.message ? truncate(r.message, LOG_MESSAGE_CELL_CAP, "use --full").value : null]),
      )
    : emptyList("recent");
  return doc(
    `loop: ${scalar(name)} (${loopId}) · role ${role} · goal ${goal != null ? scalar(goal) : "none"}`,
    recentBlock,
    helpBlock([
      "Run `loopany show` for the full config, `loopany log` for the run survey",
      "Run `loopany report --status nothing-new` to close this run",
    ]),
  );
}

function isStatus(s: string | undefined): s is RunStatus {
  return s === "new" || s === "resolved" || s === "nothing-new";
}

function validateState(
  raw: string,
  schema?: StateField[],
): { ok: true; value: Record<string, number | string> } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "--state must be a JSON object, e.g. --state '{\"mrr\":9160}'" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "--state must be a JSON object" };
  const allowed = schema?.length ? new Set(schema.map((f) => f.key)) : null;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (allowed && !allowed.has(k)) return { ok: false, error: `--state has unknown key "${k}". Allowed: ${[...allowed].join(", ")}` };
    // Finite number (chart point) or non-empty string (the UI binds it; chart ignores)
    // — same contract as the widened run.state column + the workflow mirror path.
    // NUL-strip string keys/values: a JSON-escaped \u0000 in the raw flag survives
    // parseFlags (no literal NUL yet) and only materializes at JSON.parse here -
    // and pg jsonb rejects it where SQLite tolerated it.
    if (typeof v === "number" && Number.isFinite(v)) out[stripNul(k)] = v;
    else if (typeof v === "string" && v) out[stripNul(k)] = stripNul(v);
    else return { ok: false, error: `--state.${k} must be a finite number or a non-empty string` };
  }
  return { ok: true, value: out };
}

/** Tiny flag parser: `--k v` pairs, bare `--flag` → true, first positional under `_`.
 *  Every key/value is NUL-stripped HERE - flags are wire input by definition, and
 *  several dispatch verbs (`report --message`, `finish --reason`, `set-name`, state
 *  values) write flag strings straight into pg text/jsonb columns, which REJECT
 *  NUL (SQLite tolerated it). One chokepoint covers every verb at once. */
function parseFlags(args: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = stripNul(a.slice(2));
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = stripNul(next);
        i++;
      } else {
        out[key] = true;
      }
    } else if (out["_"] === undefined) {
      out["_"] = stripNul(a);
    }
  }
  return out;
}

/** Milliseconds between a cron's next two fires, probed IN the loop's timezone
 *  (fire times shift with it) — the self-schedule cron floor's adjacent-interval
 *  check. Null when the expression can't fire twice / is invalid (the caller has
 *  already run validCadence, so null here just skips the floor). Built on the
 *  shared `nextFires` probe (index.ts) - one Cron-probing discipline, no fork. */
function cronIntervalMs(cron: string, timezone?: string | null): number | null {
  const [a, b] = nextFires(cron, timezone, 2);
  if (!a || !b) return null;
  return Date.parse(b) - Date.parse(a);
}
