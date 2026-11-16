import type { Context } from "@earendil-works/chord";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Deps } from "../deps.ts";

export class PermanentSubmissionError extends Error {}

/** A lease owns local linking, never SDK admission. Reclaims always resubmit
 * the saved draft with the same requestId on the same durable conversation. */
export async function reconcileSubmissions(
  deps: Pick<Deps, "store" | "log" | "bus">,
  main: Pick<Conversation, "submit">,
  ctx: Context,
  options: { sweepId?: number; now?: number; beforeLink?: () => void } = {},
): Promise<void> {
  const { store, log, bus } = deps;
  const now = options.now ?? Date.now();
  const candidates =
    options.sweepId === undefined
      ? store.submissions.pending(now)
      : [store.submissions.get(options.sweepId)].filter((row) => row !== undefined);
  for (const candidate of candidates) {
    const claim = store.submissions.claim(candidate.sweepId, now);
    if (!claim) continue;
    try {
      const submission = await main.submit(claim.payload, ctx);
      options.beforeLink?.();
      if (!store.submissions.link(claim, submission.id as number)) continue;
      log.info("sweep.submission_linked", {
        sweepId: claim.sweepId,
        submissionId: submission.id,
        attempts: claim.attempts,
      });
      bus.publish({ type: "sweep", sweep: store.sweeps.get(claim.sweepId)! });
    } catch (error) {
      // Unknown errors include "accepted but response lost". Keep the intent
      // retryable; inventing another requestId would duplicate accepted work.
      const permanent =
        error instanceof PermanentSubmissionError ||
        (error instanceof Error &&
          /^Request .+ already identifies a submission of type /.test(error.message));
      store.submissions.release(claim, error, permanent);
      log.warn("sweep.submission_failed", {
        sweepId: claim.sweepId,
        permanent,
        error: String(error),
      });
    }
  }
}
