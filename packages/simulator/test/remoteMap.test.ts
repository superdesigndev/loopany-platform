/**
 * REMOTE-tier assignee mapping (pure): bare profile-named assignees become
 * machine-addressed (`<alias>/<name>`) in setup argv, human reassigns, and the
 * materialized replay script - person emails and already-addressed names pass
 * through untouched. The live proof is the fly runs; this pins the pure rule.
 */
import { describe, expect, it } from "vitest";
import { mapArgvAssignees } from "../src/engine.js";
import type { Profiles } from "@loopany/cli";

const PROFILES: Profiles = {
  claude: { cmd: "claude" },
  replay: { cmd: "node" },
};

describe("mapArgvAssignees", () => {
  it("maps bare profile names onto the machine's EXECUTOR SLOT (the daemon runs slots, not profile names)", () => {
    expect(
      mapArgvAssignees(["create", "x", "--assignee", "claude"], PROFILES, "sim-1"),
    ).toEqual(["create", "x", "--assignee", "sim-1/claude"]);
    // The replay profile ALSO collapses onto the claude slot - which binary the
    // slot executes is the driver's LOOPANY_SIM_CLAUDE_BIN binding.
    expect(
      mapArgvAssignees(["update", "t", "assignee=replay"], PROFILES, "sim-1"),
    ).toEqual(["update", "t", "assignee=sim-1/claude"]);
    expect(
      mapArgvAssignees(["update", "t", "assignee=replay"], PROFILES, "sim-1", "codex"),
    ).toEqual(["update", "t", "assignee=sim-1/codex"]);
  });

  it("leaves person emails, addressed names, and non-profile names untouched", () => {
    expect(
      mapArgvAssignees(["update", "t", "assignee=tim@x.co"], PROFILES, "sim-1"),
    ).toEqual(["update", "t", "assignee=tim@x.co"]);
    expect(
      mapArgvAssignees(["create", "x", "--assignee", "other/claude"], PROFILES, "sim-1"),
    ).toEqual(["create", "x", "--assignee", "other/claude"]);
    expect(
      mapArgvAssignees(["create", "x", "--assignee", "nobody"], PROFILES, "sim-1"),
    ).toEqual(["create", "x", "--assignee", "nobody"]);
  });

  it("never rewrites unrelated tokens (a note whose text contains assignee=)", () => {
    const argv = ["note", "t", "the field assignee=claude is set elsewhere"];
    // Free-text positionals are not the k=v position, but the mapper is
    // conservative either way: only an exact `assignee=<bare-profile>` token
    // changes, and this token has trailing prose.
    expect(mapArgvAssignees(argv, PROFILES, "sim-1")).toEqual(argv);
  });

  it("does not mutate its input", () => {
    const argv = ["create", "x", "--assignee", "claude"];
    mapArgvAssignees(argv, PROFILES, "sim-1");
    expect(argv).toEqual(["create", "x", "--assignee", "claude"]);
  });
});
