# superdesign-web (fixture stand-in)

A ~50-line STAND-IN for the real Superdesign web app, used by the W3 regression
arc of the simulator. It is NOT the real codebase - it exists so a fix task is
genuine work: it carries a real planted bug whose real error message is what the
world mirrors show.

## The component

`public/install-wrapper.js` renders the library page's "Use prompt" panel. Its
copy button writes the skill wrapper to the clipboard. It has a planted bug: it
calls `new ClipboardItem(...)` unguarded, which throws on Safari-like
environments that expose `navigator.clipboard.writeText` but not `ClipboardItem`.

## Run the test

```
node --test test/wrapper.test.mjs
```

The test drives the copy path under a Safari-like clipboard (no `ClipboardItem`)
and asserts it does not throw. Against the planted bug it FAILS - node reports
`ReferenceError: ClipboardItem is not defined`; on real Safari the same code path
throws `TypeError: undefined is not an object (evaluating 'new ClipboardItem')`,
which is the error text the world mirrors show.

The fix is to fall back to `navigator.clipboard.writeText` when `ClipboardItem`
is undefined.
