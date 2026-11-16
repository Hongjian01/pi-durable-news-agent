import { createHash } from "node:crypto";
import type { Deps } from "../deps.ts";
import type { Item } from "../db/repos/news.ts";
import { yes } from "@dna/jev";
import { pageText } from "./page.ts";
import { execution, FencedExecution } from "../db/execution.ts";
import { JudgmentRetry } from "./operations.ts";
import { evaluation } from "./context.ts";
import {
  shortlist,
  storyAction,
  STORY_THRESHOLDS,
  type StoryAction,
  type StoryVerdict,
} from "./story-policy.ts";

type StoryDeps = Pick<Deps, "store" | "judge" | "http" | "log" | "bus">;

/** One matcher per sweep. Page reads are shared, verdicts persist across process restarts. */
export class StoryMatcher {
  private pages = new Map<number, Promise<string | undefined>>();
  constructor(private readonly deps: StoryDeps) {}

  private async evidence(item: Item) {
    if (!this.pages.has(item.id)) this.pages.set(item.id, pageText(this.deps, item, 2000));
    const text = await this.pages.get(item.id);
    return {
      title: item.title.slice(0, 300),
      source_url: item.url.slice(0, 1024),
      source: (item.sourceName ?? "unknown").slice(0, 200),
      published_at: item.publishedAt ?? "unknown",
      excerpt: (item.excerpt ?? "").slice(0, 500),
      article_text: text ?? "",
      article_available: !!text,
      findings: this.deps.store.news
        .findings(item.id)
        .slice(-1)
        .map((f) => ({
          summary: f.summary.slice(0, 400),
          claims: f.claimSupport.slice(0, 3).map((c) => ({ ...c, claim: c.claim.slice(0, 180) })),
          evidence_urls: f.evidence.slice(0, 3).map((url) => url.slice(0, 200)),
        })),
    };
  }

  async compare(
    candidate: Item,
    other: Item,
    sweepId?: number,
  ): Promise<{ action: StoryAction; verdict: StoryVerdict }> {
    const { store, judge } = this.deps;
    const membership = store.news.membership(other.id);
    const members = membership
      ? store.news.storyMembers(membership.storyId).filter((i) => i.id !== candidate.id)
      : [other];
    const relevant = shortlist(candidate, members, 5);
    const selected = [
      ...new Map([other, ...relevant, ...members.slice(-10)].map((i) => [i.id, i])).values(),
    ].slice(0, 5);
    const developments = [];
    // Bounded page fetching, with one shared promise per article.
    for (const member of selected)
      developments.push({
        role: store.news.membership(member.id)?.role ?? "development",
        ...(await this.evidence(member)),
      });
    const state = {
      candidate: await this.evidence(candidate),
      existing: {
        title: other.title.slice(0, 300),
        developments,
        history_truncated: selected.length < members.length,
      },
      input_limits: { history_fragments: 5, fragment_characters: 2000, total_characters: 16000 },
    };
    while (JSON.stringify(state).length > 16000 && state.existing.developments.length > 0) {
      state.existing.developments.pop();
      state.existing.history_truncated = true;
    }
    const hash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const context = evaluation(store, sweepId);
    const version = judge.command("same-story", sweepId).version;
    const prior = context
      ? undefined
      : (store.db
          .prepare(`SELECT answers_json FROM story_decisions
      WHERE item_id=? AND other_item_id=? AND version=? AND evidence_hash=?`)
          .get(candidate.id, other.id, version, hash) as any);
    const verdict: StoryVerdict = prior
      ? JSON.parse(prior.answers_json)
      : await (async () => {
          const result = await judge.run("same-story", state, { itemId: candidate.id, sweepId });
          return Object.fromEntries(
            ["same", "development", "covered", "addition", "sufficient"].map((k) => [
              k,
              yes(result.answers[k], k),
            ]),
          ) as unknown as StoryVerdict;
        })();
    const thresholds = Object.fromEntries(
      Object.entries(STORY_THRESHOLDS).map(([key, fallback]) => [
        key,
        judge.policy("same-story", key, fallback, sweepId),
      ]),
    ) as typeof STORY_THRESHOLDS;
    const action = state.existing.history_truncated
      ? "uncertain"
      : storyAction(verdict, thresholds);
    if (!prior)
      store.db
        .prepare(`INSERT INTO story_decisions
      (item_id, other_item_id, version, evidence_hash, state_json, answers_json, action, sweep_id, created_at,context_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,?)`)
        .run(
          candidate.id,
          other.id,
          version,
          hash,
          JSON.stringify(state),
          JSON.stringify(verdict),
          action,
          sweepId ?? null,
          new Date().toISOString(),
          context ? "versioned" : "legacy_unversioned",
        );
    return { action, verdict };
  }

  publish(storyId: number) {
    for (const id of this.deps.store.news.storyCardIds(storyId)) {
      const card = this.deps.store.news.card(id)!;
      this.deps.bus.publish({ type: "feed.card_updated", card });
    }
  }

  /** Each candidate is resolved before the next one, so same-sweep coverage sees the full story accumulated so far. */
  async classify(
    item: Item,
    history: Item[],
    sweepId?: number,
    reconsider = false,
  ): Promise<StoryAction | "new"> {
    const { store, judge, log } = this.deps;
    const existing = store.news.membership(item.id);
    if (existing && (!reconsider || store.news.storyMembers(existing.storyId).length > 1))
      return "new";
    const options = shortlist(item, history, judge.policy("same-story", "shortlist", 12));
    const seen = new Set<string>();
    const matches: { other: Item; action: StoryAction; verdict: StoryVerdict }[] = [];
    let failed = false;
    const errors: unknown[] = [];
    // Compare a candidate with at most one representative per story, in bounded batches.
    const candidates = options.filter((other) => {
      const key = String(store.news.membership(other.id)?.storyId ?? `item:${other.id}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (let n = 0; n < candidates.length; n += 4) {
      await Promise.all(
        candidates.slice(n, n + 4).map(async (other) => {
          try {
            matches.push({ other, ...(await this.compare(item, other, sweepId)) });
          } catch (error) {
            failed = true;
            errors.push(error);
            log.warn("sweep.same_story_failed", {
              itemId: item.id,
              otherId: other.id,
              error: String(error),
            });
          }
        }),
      );
      if (execution.getStore()) {
        const retry = errors.find(
          (error) => error instanceof JudgmentRetry || error instanceof FencedExecution,
        );
        if (retry) throw retry;
        if (failed) {
          store.news.failItem(item.id, "same_story_failed");
          if (sweepId)
            store.lifecycle.item(sweepId, item.id, {
              disposition: "error",
              reason: "same_story_failed",
            });
          return "uncertain";
        }
      }
    }
    const confident = matches.filter((m) =>
      ["duplicate", "evidence", "development"].includes(m.action),
    );
    // Multiple plausible stories need research, never an arbitrary first-match merge.
    if (confident.length === 1) {
      const match = confident[0];
      const role =
        match.action === "duplicate" ? "coverage" : (match.action as "evidence" | "development");
      const id = store.news.attachStory(item, match.other, role);
      this.publish(id);
      log.info("story.linked", {
        itemId: item.id,
        otherId: match.other.id,
        storyId: id,
        action: match.action,
        verdict: match.verdict,
        sweepId,
      });
      return match.action;
    }
    store.news.ensureStory(item);
    const uncertain =
      failed || matches.some((m) => m.action === "uncertain") || confident.length > 1;
    if (uncertain)
      store.news.updateItem(item.id, {
        lastError: "Story relationship uncertain: research before suppressing or linking",
      });
    return uncertain ? "uncertain" : "new";
  }
}
