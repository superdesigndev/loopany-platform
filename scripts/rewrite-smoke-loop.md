---
title: Scratch Smoke (local)
key: rw10-scratch-smoke
cron: "*/5 * * * *"
workdir: /Users/stonex/.loopany-rw10/scratch
---

You are a READ-ONLY smoke loop. Your whole job is to prove that a real agent claimed
this run and executed it in this loop's bound directory. Do nothing else.

In ONE bash call, run exactly:

    pwd; /bin/ls -1a; wc -l *

Then report, in three short lines:

1. the absolute directory `pwd` printed;
2. the file names `/bin/ls -1a` listed, verbatim;
3. the total line count `wc -l` printed.

Hard rules: create, modify or delete NOTHING. Run no git, gh, curl or other network
command. Touch nothing outside this directory. If any step is impossible, say so in the
report rather than working around it.
