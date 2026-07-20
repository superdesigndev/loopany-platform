/**
 * gateway/mrkdwn.ts — a pure, dependency-free Markdown → Slack mrkdwn converter.
 * Slack's `chat.postMessage` `text` field renders mrkdwn, not standard Markdown
 * (different bold/strike syntax, no tables, no headings) — used by
 * `CHANNELS.slack.send` (`notify.ts`) to translate a run's Markdown message
 * before posting. No I/O, no clock, unit-tested in isolation (`mrkdwn.test.ts`).
 */

/** Convert standard Markdown `text` to Slack mrkdwn. */
export function markdownToMrkdwn(text: string): string {
  let result = text;

  // Protect fenced/inline code first so nothing inside gets rewritten by the
  // Markdown → mrkdwn substitutions below, then restore verbatim at the end.
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `__INLINECODE_${inlineCode.length - 1}__`;
  });

  // mrkdwn has no table syntax — wrap a Markdown table (incl. its `---` divider
  // row, stripped) in a code fence so it stays readable monospace.
  result = result.replace(/((?:^[ \t]*\|.+\|[ \t]*$[\r\n]*){2,})/gm, (tableBlock) => {
    const lines = tableBlock
      .trim()
      .split("\n")
      .filter((line) => !line.match(/^\|(?:[\s\-:]+\|)+$/));
    return "```\n" + lines.join("\n") + "\n```";
  });

  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // heading -> bold line
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*"); // **bold** -> *bold*
  result = result.replace(/~~(.+?)~~/g, "~$1~"); // ~~strike~~ -> ~strike~
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>"); // [text](url) -> <url|text>
  result = result.replace(/^[\s]*[-*]\s+/gm, "• "); // list bullet
  result = result.replace(/^[-*]{3,}$/gm, "———"); // --- -> divider

  result = result.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]!);
  result = result.replace(/__INLINECODE_(\d+)__/g, (_, i) => inlineCode[Number(i)]!);

  return result;
}
