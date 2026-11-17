import type { Snapshot } from "../../news/snapshots.ts";
import { FixableError } from "./shared.ts";

/** Navigation only: source headings stay data and their offsets address the
 * immutable body. Ignore fenced code examples that happen to contain '#'. */
export function snapshotOutline(body: string): string[] {
  const headings: string[] = [];
  let offset = 0, fence: string | undefined;
  for (const line of body.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = undefined;
    } else if (!fence && /^#{1,6}\s+/.test(line)) {
      if (headings.length === 60) { headings.push("Additional headings omitted from navigation index; source body is unchanged."); break; }
      headings.push(`start_char=${offset}: ${line.trim().slice(0, 180)}`);
    }
    offset += line.length + 1;
  }
  return headings.length ? ["[source navigation: heading offsets, not evidence]", ...headings, "Use a relevant start_char or find_text instead of scanning every page.", "[/source navigation]"] : [];
}

/** Reading a window does not truncate or change the immutable evidence snapshot. */
export function snapshotWindow(
  snapshot: Snapshot,
  args: { start_char?: number; max_chars?: number; find_text?: string },
  defaultSize: number,
): string[] {
  let start = args.start_char ?? 0;
  if (!Number.isInteger(start) || start < 0 || start > snapshot.body.length)
    throw new FixableError("start_char is outside this snapshot", [
      "Use the reported next_start_char or a valid UTF-16 position.",
    ]);
  if (args.find_text) {
    const literal = args.find_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(literal, "iu").exec(snapshot.body.slice(start));
    if (!match)
      throw new FixableError("find_text not found in the remaining snapshot", [
        "Try another exact phrase, or read successive windows. No match for this phrase does not establish that the capability is absent.",
      ]);
    start += match.index;
  }
  // Do not start or end a displayed page inside a UTF-16 surrogate pair.
  if (
    start > 0 &&
    /[\uDC00-\uDFFF]/.test(snapshot.body[start] ?? "") &&
    /[\uD800-\uDBFF]/.test(snapshot.body[start - 1])
  )
    start--;
  let end = Math.min(snapshot.body.length, start + (args.max_chars ?? defaultSize));
  if (
    end < snapshot.body.length &&
    /[\uDC00-\uDFFF]/.test(snapshot.body[end]) &&
    /[\uD800-\uDBFF]/.test(snapshot.body[end - 1] ?? "")
  )
    end--;
  return [
    `snapshot: ${snapshot.id} | body_hash: ${snapshot.body_hash} | fetched_at: ${snapshot.fetched_at} | offsets: UTF-16`,
    `view_start: ${start} | view_end: ${end} | total_chars: ${snapshot.body.length} | has_more: ${end < snapshot.body.length} | source_truncated: ${!!snapshot.truncated}`,
    ...(end < snapshot.body.length
      ? [
          `next_start_char: ${end}. Continue reading with start_char or find a relevant section with find_text; a partial view is not the full source.`,
        ]
      : []),
    ...(start === 0 ? snapshotOutline(snapshot.body) : []),
    "[snapshot text]",
    snapshot.body.slice(start, end),
    "[/snapshot text]",
  ];
}
