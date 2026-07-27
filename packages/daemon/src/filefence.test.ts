import { describe, expect, it } from "vitest";

import { ALLOW_EXTERNAL_FLAG, fenceFileFlag, isWithinCwd } from "./filefence.js";
import { inlineFileFlags } from "./cli-client.js";

describe("isWithinCwd", () => {
  it("accepts the cwd itself, relative children, and ./-prefixed paths", () => {
    expect(isWithinCwd(".", "/work")).toBe(true);
    expect(isWithinCwd("payload.md", "/work")).toBe(true);
    expect(isWithinCwd("./sub/payload.md", "/work")).toBe(true);
    expect(isWithinCwd("/work/sub/x.md", "/work")).toBe(true);
  });

  it("rejects parent escapes, absolute outside paths, and prefix-sibling traps", () => {
    expect(isWithinCwd("../other/x.md", "/work")).toBe(false);
    expect(isWithinCwd("/tmp/x.md", "/work")).toBe(false);
    // /workspace shares the /work prefix but is a SIBLING — naive startsWith would pass it.
    expect(isWithinCwd("/workspace/x.md", "/work")).toBe(false);
    expect(isWithinCwd("sub/../../x.md", "/work")).toBe(false);
  });
});

describe("fenceFileFlag", () => {
  it("allows in-cwd paths and anything under --allow-external-file", () => {
    expect(fenceFileFlag("--message-file", "./m.md", "/work", false)).toBeNull();
    expect(fenceFileFlag("--message-file", "/tmp/m.md", "/work", true)).toBeNull();
  });

  it("refuses an external path with an actionable message naming the flag", () => {
    const msg = fenceFileFlag("--ui-file", "/tmp/ui.html", "/work", false);
    expect(msg).toContain("--ui-file");
    expect(msg).toContain("/tmp/ui.html");
    expect(msg).toContain(ALLOW_EXTERNAL_FLAG);
  });
});

describe("inlineFileFlags fence integration", () => {
  const read = (p: string) => `<content of ${p}>`;

  it("inlines an in-cwd content file and never forwards the escape flag", () => {
    const r = inlineFileFlags(["set-workflow", "--file", "./wf.js", ALLOW_EXTERNAL_FLAG], read, "/work");
    expect(r).toEqual({ ok: true, argv: ["set-workflow", "--file-content", "<content of ./wf.js>"] });
  });

  it("refuses a /tmp CONTENT file (--file → persistent workflow/ui) with the fence detail", () => {
    const r = inlineFileFlags(["set-workflow", "--file", "/tmp/wf.js"], read, "/work");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe("/tmp/wf.js");
      expect(r.detail).toContain("--file");
      expect(r.detail).toContain(ALLOW_EXTERNAL_FLAG);
    }
  });

  it("allows a /tmp content file when --allow-external-file rides the argv", () => {
    const r = inlineFileFlags(["set-workflow", "--file", "/tmp/wf.js", ALLOW_EXTERNAL_FLAG], read, "/work");
    expect(r).toEqual({ ok: true, argv: ["set-workflow", "--file-content", "<content of /tmp/wf.js>"] });
  });

  it("EPHEMERAL flags (--message-file/--state-file) stay unfenced — live agents mktemp those", () => {
    const r = inlineFileFlags(["report", "--message-file", "/tmp/m.md"], read, "/work");
    expect(r).toEqual({ ok: true, argv: ["report", "--message", "<content of /tmp/m.md>"] });
  });

  it("still surfaces a plain read failure for an in-cwd path", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    const r = inlineFileFlags(["set-workflow", "--file", "./wf.js"], boom, "/work");
    expect(r).toMatchObject({ ok: false, path: "./wf.js" });
    if (!r.ok) expect(r.detail).toBeUndefined();
  });
});
