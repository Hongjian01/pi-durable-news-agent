import type { Snapshot } from "../../news/snapshots.ts";
import { FixableError } from "./shared.ts";

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
    "[snapshot text]",
    snapshot.body.slice(start, end),
    "[/snapshot text]",
  ];
}
