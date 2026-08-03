import { describe, expect, it } from "vitest";

import { REFUSAL_CODES, REFUSAL_STATUS, REFUSAL_TEMPLATES, refusal, refuseAbout, refusalResponse, renderTemplate } from "./refusals.js";

/**
 * The guard table (CLI spec §8). Its four properties are asserted here as
 * properties of the catalogue, not per-call-site: a refusal that reaches an agent
 * without a sentence, without a legal next move, or with a boilerplate
 * placeholder is a wall rather than a teacher, and that regression is silent
 * everywhere except here.
 */
describe("the refusal catalogue", () => {
  it("renders every declared code as one complete structured envelope", () => {
    for (const code of REFUSAL_CODES) {
      const rendered = renderTemplate(code, "task-7f3a91");
      expect(rendered.message.length, `${code} message`).toBeGreaterThan(10);
      expect(rendered.hint.length, `${code} hint`).toBeGreaterThan(10);
      expect(rendered.issues).toEqual([]);
      // The subject is substituted, never left as a format token.
      expect(rendered.message).not.toContain("%s");
      // No code may fall back to naming itself — that is the generic envelope
      // the CLI scout's guard-table recommendation exists to prevent.
      expect(rendered.message).not.toContain(code);
      expect(refusal(code)).toEqual({ code, message: renderTemplate(code).message, issues: [], hint: REFUSAL_TEMPLATES[code].hint });
    }
  });

  it("gives every code an HTTP status, and the status determines the CLI's exit class", () => {
    for (const code of REFUSAL_CODES) {
      const status = REFUSAL_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(500);
    }
    // Spec §4: 404 is its own exit class precisely because retrying the same id
    // is guaranteed useless; 401/429 are transport, everything else is teaching.
    expect(REFUSAL_STATUS.NOT_FOUND).toBe(404);
    expect(REFUSAL_STATUS.UNAUTHORIZED).toBe(401);
    expect(REFUSAL_STATUS.RATE_LIMITED).toBe(429);
  });

  it("keeps ownership and human-only refusals on their own codes, not a bare FORBIDDEN", () => {
    // A charter can say "if you see NOT_YOUR_LOOP you copied the wrong id" only
    // because the guard has its own slug (CLI spec §3.3).
    for (const code of ["NOT_YOUR_LOOP", "NOT_HUMAN", "NOT_YOUR_RUN", "NO_RUN_CONTEXT"] as const) {
      expect(REFUSAL_STATUS[code]).toBe(403);
    }
    const codes = new Set(REFUSAL_CODES as readonly string[]);
    expect(codes.has("FORBIDDEN")).toBe(false);
  });

  it("carries the subject into the message and keeps caller overrides", () => {
    expect(refuseAbout("NOT_FOUND", "task-000000").message).toBe("task-000000 was not found");
    const specific = refusal("UNKNOWN_KEY", 'unknown key "follow_ups" in a task artifact', [{ path: "follow_ups", message: "unknown key", got: "follow_ups", expected: "follow_up" }], "did you mean follow_up?");
    expect(specific).toEqual({ code: "UNKNOWN_KEY", message: 'unknown key "follow_ups" in a task artifact', issues: [{ path: "follow_ups", message: "unknown key", got: "follow_ups", expected: "follow_up" }], hint: "did you mean follow_up?" });
  });

  it("maps the envelope onto the response with the code's own status", async () => {
    const response = refusalResponse(refuseAbout("OPEN_QUESTION", "task-0b19ac"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "OPEN_QUESTION", hint: expect.stringContaining("inbox") });
  });
});
