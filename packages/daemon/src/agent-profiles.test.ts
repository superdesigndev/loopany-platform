import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { detectAgentProfiles } from "./agent-profiles.js";

describe("daemon agent capabilities", () => {
  test("reports only executables available to the daemon", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopany-agents-"));
    for (const name of ["claude", "codex"]) {
      const file = join(dir, name);
      writeFileSync(file, "#!/bin/sh\n"); chmodSync(file, 0o755);
    }
    expect(detectAgentProfiles({ PATH: dir })).toEqual(["claude", "codex"]);
  });

  test("honors an explicit runner binary path", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopany-agent-override-"));
    const file = join(dir, "my-claude");
    writeFileSync(file, "#!/bin/sh\n"); chmodSync(file, 0o755);
    expect(detectAgentProfiles({ PATH: "", LOOPANY_CLAUDE_BIN: file })).toEqual(["claude"]);
  });
});
