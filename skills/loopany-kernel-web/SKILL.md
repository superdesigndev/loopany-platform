---
name: loopany-kernel-web
description: Open and embed the Loopany Kernel team workspace in a dedicated Codex desktop window. Use when the user asks to open Loopany, lk, Inbox, Task Tree, Task Board, Documents, or Timeline inside Codex, or asks to install, launch, reconnect, or troubleshoot the embedded Loopany Kernel Web UI.
---

# Loopany Kernel Web

Run the bundled launcher:

```bash
node <skill-directory>/scripts/open-in-codex.mjs
```

The launcher opens an independent Codex desktop window, adds a `Loopany` item
after Plugins in its sidebar, and shows the authenticated Kernel Web UI in the
main workspace. Existing Codex windows are not modified. Keep the launcher
running while using the embedded page; stop it with Ctrl+C.

The first launch asks the human to sign in inside the embedded page. Never ask
for, read, store, or pass the shared password on the command line.

Use `--attach` to target an already-running Codex window that was started with
the launcher's CDP port. Use `--url` or `--port` only when the user requests a
different Kernel deployment or debug port. Run `--help` for exact syntax.

This skill opens the human workspace. Use the separate `loopany-kernel` skill
and `lk` CLI for agent-side Task, Loop, Doc, and Timeline operations.
