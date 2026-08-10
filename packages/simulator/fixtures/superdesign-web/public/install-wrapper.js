// The library page "Use prompt" panel: copy the skill wrapper to the clipboard.
// PLANTED BUG: `new ClipboardItem(...)` is called unguarded. Safari-like
// environments expose navigator.clipboard.writeText but NOT ClipboardItem, so
// this throws:
//   TypeError: undefined is not an object (evaluating 'new ClipboardItem')

export async function copyWrapper(clipboard, text) {
  // BUG: assumes ClipboardItem exists. On Safari it is undefined.
  const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) });
  await clipboard.write([item]);
  return "copied";
}
