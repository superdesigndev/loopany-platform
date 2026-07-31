#!/usr/bin/env bash
#
# The SUCCESS STUB executor for the machine agent.
#
# `LOOPANY_AGENT_EXEC_COMMAND` names the binary a `run-task` work order is handed
# to: in production that is a coding agent, and in a demo or a probe the
# machine-agent README says it is "a bounded script". This is that script.
#
# It reads the instruction on stdin, prints a short honest report, and exits 0.
# It writes nothing, fetches nothing and runs nothing else - which is exactly the
# posture an environment wants while it is proving that the CHANNEL works
# (claim → lease → run → report → the task advances) without letting an LLM loose
# on somebody's repository. Swapping in a real executor is one environment
# variable, and that is a deliberate decision, not a default.
#
#   LOOPANY_AGENT_EXEC_COMMAND=<repo>/scripts/agent-exec-success-stub.sh
#
# The instruction is never echoed back in full: a work order carries the graph's
# own context, and a stub's job is to prove delivery, not to reprint it.
set -euo pipefail

bytes=$(wc -c </dev/stdin | tr -d ' ')

cat <<EOF
success-stub: instruction received (${bytes} bytes) in $(pwd)

This executor is a STUB. It performed no work: no files were written, no network
call was made, and no repository was touched. It exists to prove the run channel
end to end - claim, lease, execute, report - in an environment that is not yet
authorized to act on the outside world.

FINDING: none - stub executor, no work performed.
EOF
