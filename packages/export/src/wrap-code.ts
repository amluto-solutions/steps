/**
 * Code set on paper (PDF and Word), wrapped to `width` characters of a monospace font: only at a
 * space, never inside a word, so a command's `-AccessRights` is never split into "-" and
 * "AccessRights" the way a page layout breaks after a hyphen. A continued line is indented two
 * spaces more than its first. A word longer than the line is cut.
 */
export function wrapCode(text: string, width: number): string {
  const limit = Math.max(20, Math.floor(width));
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, limit))
    .join("\n");
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const indent = /^\s*/.exec(line)?.[0].length ?? 0;
  const continuation = " ".repeat(Math.min(indent + 2, Math.floor(width / 2)));
  const out: string[] = [];
  let rest = line;
  let prefix = "";
  while (prefix.length + rest.length > width) {
    const room = width - prefix.length;
    // The last space that fits, after any indentation; with none, a hard cut.
    const space = rest.lastIndexOf(" ", room);
    const floor = prefix ? 0 : indent;
    const cut = space > floor ? space : room;
    out.push(prefix + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    prefix = continuation;
  }
  if (rest) out.push(prefix + rest);
  return out;
}
