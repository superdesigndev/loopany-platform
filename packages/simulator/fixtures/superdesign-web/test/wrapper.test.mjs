import { test } from "node:test";
import assert from "node:assert/strict";
import { copyWrapper } from "../public/install-wrapper.js";

// A Safari-like clipboard: writeText exists, ClipboardItem does not. The global
// ClipboardItem is deliberately left undefined for this run.
test("copyWrapper works on a Safari-like clipboard (no ClipboardItem)", async () => {
  let written = "";
  const clipboard = {
    async writeText(t) {
      written = t;
    },
    async write() {
      throw new Error("write([ClipboardItem]) path taken");
    },
  };
  const out = await copyWrapper(clipboard, "the wrapper text");
  assert.equal(out, "copied");
  assert.equal(written, "the wrapper text");
});
