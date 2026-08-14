# Loopany first capture

The user pasted a Loopany capture snippet into this coding-agent session. Help
them create a durable Task or recurring Loop in the selected team. Keep the
conversation focused and confirm material choices before writing.

## Pasted values

- `server-url` is the Loopany server base URL.
- `team-id` is the explicit destination team when present.
- `loopany-cli` is an optional command prefix. If absent, use
  `npx @crewlet/loopany@latest` for daemon commands and `lk` for Kernel commands.
- Text below the values is the template intent, when the user started from a
  template card.

No pasted value is a credential. Never ask the user to paste a session token or
machine key into chat, a prompt, a file, or a command line.

## 1. Set up this computer for the selected Team

Use the selected Team's stable workspace path and ask the user to run one command:

```bash
lk setup /<team-slug> --server <server-url>
```

This starts browser login only when needed, enrolls or reuses the physical
Machine, starts the resident runtime, binds the Machine to the Team after a live
membership check, and makes that Team the default human CLI workspace. No setup
token or Machine credential is pasted. Do not approve browser login for the user.

The runtime's restricted Machine credential can poll, claim Runs, sync artifacts,
and identify the Machine. It cannot perform human Task or Kernel writes. A Run's
lease fixes its Team and ignores the human CLI default.

If the local machine is already enrolled to another account, do not overwrite it.
Follow the CLI instruction to stop the old daemon or use a separate
`LOOPANY_HOME`.

## 2. Build the Task or Loop

Use the installed `loopany-kernel` skill and `lk` commands. For every Task or
recurring Loop, read the create reference:

```text
<server-url>/api/skill/references/create.md
```

Determine the standing specification, assignment, external entities, acceptance
evidence, and durable outputs, plus cadence and workflow for a Loop. Human emails
and names are input aliases only. The server stores the canonical
`person:<user-id>` identity and refuses ambiguous names. Use the selected team
throughout. Do not use `connect-key`, `dk_`, or a machine credential for authoring.
