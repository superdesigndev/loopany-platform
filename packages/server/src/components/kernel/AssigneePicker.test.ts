// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test, vi } from "vitest";
import { AssigneePicker } from "./AssigneePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AssigneePicker", () => {
  test("groups canonical Team people and Machine agents", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(AssigneePicker, {
      value: "",
      onChange: vi.fn(),
      options: [
        { value: "person:u-1", label: "tim@example.com", detail: "owner", kind: "person" },
        { value: "mbp/codex", label: "mbp/codex", detail: "available", kind: "agent" },
      ],
    })));
    const groups = [...host.querySelectorAll("optgroup")];
    expect(groups.map((group) => group.label)).toEqual(["People", "Agents"]);
    expect(host.textContent).toContain("tim@example.com · owner");
    expect(host.textContent).toContain("mbp/codex · available");
    act(() => root.unmount());
  });
});
