// The Judge: every jev command the app runs, with each call priced, logged and stored in jev_calls.
import { join } from "node:path";
import { CLAIM_EVIDENCE_LIMIT } from "./claim-evidence.ts";
import type { HfsScores } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import {
  attentionScore,
  DEFAULT_ATTENTION,
  type AttentionWeights,
  type Decide,
  type JevCommand,
  JevLedger,
  listCommands,
  loadCommand,
  rankHfs,
  runCommand,
  type ScoreAnswer,
  type SystemOneResult,
  type Vars,
  normalized,
  yes,
  validateResponse,
  renderCommand,
} from "@dna/jev";
import type { Finding, Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import type { CallRef } from "./search/index.ts";
import { sectionKeywords, tasteExamples, topicChoices } from "./taste.ts";
import { Operations, JudgmentRetry, type JudgedResult } from "./operations.ts";
import { execution } from "../db/execution.ts";
import { evaluation, contentHash } from "./context.ts";
import { STORY_THRESHOLDS, storyAction } from "./story-policy.ts";
import { JudgmentFailed } from "./operations.ts";
import { POLICY_V1 } from "./policy-v1.ts";
import { weightsOf } from "./rank.ts";

export const JEV_COMMANDS = [
  "relevance",
  "worth-attention",
  "hfs",
  "same-story",
  "claim-support",
  "importance",
] as const;
export type JevCommandName = (typeof JEV_COMMANDS)[number] | "publication-support" | "publication-relevance" | "publication-grounding";

export interface JudgeRef extends CallRef {
  itemId?: number;
}

const excerptOf = (item: Item, store: Store, max = 1500) => {
  const cached = item.cacheId ? store.sources.cachedById(item.cacheId) : undefined;
  const body =
    cached?.contentMd && cached.contentMd.length > (item.excerpt?.length ?? 0)
      ? cached.contentMd
      : (item.excerpt ?? "");
  return body.slice(0, max);
};

export class Judge {
  private readonly baseCommands: Record<string, JevCommand>;
  readonly provider: string;
  get commands(): Record<string, JevCommand> {
    return evaluation(this.deps.store)?.value.commands ?? this.baseCommands;
  }
  command(name: JevCommandName, sweepId?: number): JevCommand {
    const context = evaluation(this.deps.store, sweepId);
    const command = context?.value.commands[name] ?? this.commands[name];
    if (context && contentHash(command) !== context.value.commandHashes[name])
      throw new JudgmentFailed("frozen_command_hash_mismatch");
    return command;
  }
  readonly ledger: JevLedger;
  readonly operations: Operations;

  constructor(
    private readonly deps: {
      decide: Decide;
      store: Store;
      log?: Logger;
      dir: string;
      provider?: string;
    },
  ) {
    this.provider = deps.provider ?? "injected";
    this.baseCommands = Object.fromEntries(
      listCommands(deps.dir).map((name) => [name, loadCommand(name, deps.dir)]),
    );
    for (const name of JEV_COMMANDS)
      if (!this.commands[name])
        throw new Error(`Missing jev command ${join(deps.dir, name, "command.json")}`);
    this.ledger = new JevLedger();
    this.operations = new Operations(deps.store);
  }

  policy<T>(name: JevCommandName, key: string, fallback: T, sweepId?: number): T {
    return (this.command(name, sweepId).policy[key] as T) ?? fallback;
  }

  get attentionWeights(): AttentionWeights {
    return this.policy("hfs", "attention", DEFAULT_ATTENTION);
  }

  /** Run one command by name, recording the call whether it succeeds or fails. */
  async run(name: JevCommandName, vars: Vars, ref: JudgeRef = {}): Promise<JudgedResult> {
    const sweepId = ref.sweepId ?? execution.getStore()?.sweepId;
    const cmd = this.command(name, sweepId);
    try {
      const context = evaluation(this.deps.store, sweepId);
      if (context && context.value.models.jevProvider !== this.provider)
        throw new JudgmentFailed("frozen_jev_provider_unavailable");
      const invoke = (input: { cmd: JevCommand; vars: Vars }) =>
        runCommand(input.cmd, input.vars, this.deps.decide, {
          signal: AbortSignal.timeout(30000),
        }).then((out) => {
          try {
            validateResponse(out.result, out.rendered.questions);
          } catch (error) {
            throw Object.assign(error as Error, { rawResponse: out.result });
          }
          return out.result;
        });
      const run = async (): Promise<SystemOneResult> => {
        try {
          return sweepId && this.deps.store.submissions.get(sweepId)
            ? await this.operations.run(
                sweepId,
                ref.itemId,
                name,
                { cmd, vars, rendered: renderCommand(cmd, vars) },
                invoke,
                {
                  commandVersion: cmd.version,
                  commandHash: contentHash(cmd),
                  requestedModel: cmd.model,
                  policyDecision: (result) => this.policyDecision(name, cmd, result),
                },
              )
            : await invoke({ cmd, vars });
        } catch (error) {
          const scope = execution.getStore();
          if (!(error instanceof JudgmentRetry) || !scope?.sleep) throw error;
          await scope.sleep(error.retryAt);
          return run();
        }
      };
      const result = await run();
      if (this.operations.cacheHits.has(result)) return result;
      const record = this.ledger.record(result, { command: cmd.name, version: cmd.version });
      this.deps.store.telemetry.jev({
        command: cmd.name,
        version: cmd.version,
        provider: record.provider,
        model: record.model,
        questions: Object.keys(result.answers).length,
        answers: result.answers,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUsd: record.cost.amount,
        costSource: record.cost.source,
        elapsedMs: record.elapsedMs,
        attempts: record.attempts,
        itemId: ref.itemId,
        sweepId: ref.sweepId,
        conversationId: ref.conversationId,
        callId: ref.callId,
      });
      this.deps.log?.debug("jev.call", {
        command: name,
        itemId: ref.itemId,
        ms: record.elapsedMs,
        cost: record.cost.amount,
        sweepId: ref.sweepId,
      });
      return result;
    } catch (error) {
      this.ledger.fail(error, { command: cmd.name, version: cmd.version });
      this.deps.store.telemetry.jev({
        command: cmd.name,
        version: cmd.version,
        questions: 0,
        error: String(error).slice(0, 500),
        itemId: ref.itemId,
        sweepId: ref.sweepId,
        conversationId: ref.conversationId,
        callId: ref.callId,
      });
      this.deps.log?.warn("jev.failed", {
        command: name,
        itemId: ref.itemId,
        error: String(error),
      });
      throw error;
    }
  }

  async relevance(
    item: Item,
    ref: JudgeRef = {},
  ): Promise<{ relevance: number; matchedTopic?: string }> {
    const topics =
      evaluation(this.deps.store, ref.sweepId)?.value.keywords.filter(
        (k) => k.kind === "topic" && k.enabled,
      ) ?? this.deps.store.taste.keywords("topic", true);
    const choices = topicChoices(topics);
    const result = await this.run(
      "relevance",
      {
        title: item.title,
        source: item.sourceName ?? "",
        excerpt: excerptOf(item, this.deps.store, 1200),
        topic_keywords: topics.map((k) => ({ term: k.term, weight: k.weight })),
        topic_choices: choices,
        taste_examples: tasteExamples(this.deps.store, 6, ref.sweepId),
      },
      { ...ref, itemId: item.id },
    );
    const relevance = normalized(result.answers.relevance as ScoreAnswer);
    const choice = (result.answers.matched_topic as { choice?: string } | undefined)?.choice;
    return { relevance, matchedTopic: choice && choice !== "none" ? choices[choice] : undefined };
  }

  /** How important a gated item is to the reader, 0 to 1, given the topic and source weights. */
  async importance(
    item: Item,
    weights: { topic: number; source: number },
    ref: JudgeRef = {},
  ): Promise<number> {
    if (evaluation(this.deps.store, ref.sweepId))
      weights = weightsOf(this.deps.store, item, ref.sweepId);
    const topics =
      evaluation(this.deps.store, ref.sweepId)?.value.keywords.filter(
        (k) => k.kind === "topic" && k.enabled,
      ) ?? this.deps.store.taste.keywords("topic", true);
    const result = await this.run(
      "importance",
      {
        title: item.title,
        source: item.sourceName ?? "",
        source_weight: weights.source,
        published_at: item.publishedAt ?? "unknown",
        excerpt: excerptOf(item, this.deps.store, 1200),
        topic: item.matchedTopic ?? "none",
        topic_weight: weights.topic,
        topic_keywords: topics.map((k) => ({ term: k.term, weight: k.weight })),
        taste_examples: tasteExamples(this.deps.store, 6, ref.sweepId),
      },
      { ...ref, itemId: item.id },
    );
    return normalized(result.answers.importance as ScoreAnswer);
  }

  async worth(item: Item, ref: JudgeRef = {}): Promise<{ worth: number; novelty: number }> {
    const result = await this.run(
      "worth-attention",
      {
        title: item.title,
        source: item.sourceName ?? "",
        published_at: item.publishedAt ?? "unknown",
        excerpt: excerptOf(item, this.deps.store, 1200),
        taste_examples: tasteExamples(this.deps.store, 6, ref.sweepId),
      },
      { ...ref, itemId: item.id },
    );
    return {
      worth: yes(result.answers.worth, "worth"),
      novelty: normalized(result.answers.novelty as ScoreAnswer),
    };
  }

  /** `text` is the item's page text when the caller fetched it; without it jev reads the cached body or excerpt. */
  async hfs(
    item: Item,
    ref: JudgeRef = {},
    findings?: Finding[],
    text?: string,
  ): Promise<HfsScores & { classificationId: number }> {
    const cmd = this.command("hfs", ref.sweepId);
    const context = evaluation(this.deps.store, ref.sweepId);
    const findingId = context
      ? (
          this.deps.store.db
            .prepare("SELECT finding_id FROM sweep_items WHERE sweep_id=? AND item_id=?")
            .get(ref.sweepId ?? execution.getStore()!.sweepId, item.id) as any
        )?.finding_id
      : undefined;
    const selectedFindings = (findings ?? this.deps.store.news.findings(item.id)).filter(
      (f) => !context || f.id === findingId,
    );
    const result = await this.run(
      "hfs",
      {
        title: item.title,
        source: item.sourceName ?? "",
        excerpt: text ?? excerptOf(item, this.deps.store, 2400),
        findings: selectedFindings
          .map((f) => ({
            summary: f.summary,
            actionability: f.actionability,
            claims: f.claimSupport,
          }))
          .slice(-3),
        section_keywords: sectionKeywords(this.deps.store, ref.sweepId),
        taste_examples: tasteExamples(this.deps.store, 6, ref.sweepId),
      },
      { ...ref, itemId: item.id },
    );
    const ranked = rankHfs(result.answers, cmd.policy as never);
    const hfs: HfsScores = {
      hype: ranked.scores.hype,
      facts: ranked.scores.facts,
      signal: ranked.scores.signal,
      primary: ranked.primary,
      labels: ranked.labels,
      ranked: ranked.ranked,
      suspectCombo: ranked.suspectCombo,
    };
    const row = this.deps.store.news.addClassification({
      itemId: item.id,
      command: cmd.name,
      version: cmd.version,
      model: result.meta.resolvedModel,
      hfs,
      answers: result.answers,
      sweepId: ref.sweepId,
      toolCallId: ref.callId,
    });
    if (evaluation(this.deps.store, ref.sweepId))
      this.deps.store.db
        .prepare("UPDATE classifications SET context_state='versioned' WHERE id=?")
        .run(row.id);
    this.deps.store.news.updateItem(item.id, {
      status: ["presented", "duplicate"].includes(item.status) ? item.status : "classified",
      attention: this.attention(hfs, item.relevance ?? 0.5),
    });
    if (hfs.suspectCombo)
      this.deps.log?.warn("hfs.suspect_combo", {
        itemId: item.id,
        ...ranked.scores,
        sweepId: ref.sweepId,
      });
    return { ...hfs, classificationId: row.id };
  }

  async sameStory(
    a: Pick<Item, "title" | "excerpt">,
    b: Pick<Item, "title" | "excerpt">,
    ref: JudgeRef = {},
  ): Promise<number> {
    const result = await this.run(
      "same-story",
      {
        candidate: { title: a.title, excerpt: a.excerpt ?? "" },
        existing: { title: b.title, developments: [{ title: b.title, excerpt: b.excerpt ?? "" }] },
      },
      ref,
    );
    return yes(result.answers.same, "same");
  }

  async claimSupport(
    claims: string[],
    evidence: string,
    ref: JudgeRef = {},
  ): Promise<{ claim: string; supported: number }[]> {
    if (!claims.length) return [];
    if (evidence.length > CLAIM_EVIDENCE_LIMIT)
      throw new Error("claim_evidence_window_required: pass a source excerpt of at most 6000 UTF-16 characters");
    const result = await this.run(
      "claim-support",
      { claims: claims.slice(0, 8), evidence },
      ref,
    );
    return claims.slice(0, 8).map((claim, i) => ({
      claim,
      supported: yes(result.answers[`supported_${i}`], `supported_${i}`),
    }));
  }

  attention(hfs: Pick<HfsScores, "hype" | "facts" | "signal">, relevance: number): number {
    return attentionScore(
      { hype: hfs.hype, facts: hfs.facts, signal: hfs.signal },
      relevance,
      this.attentionWeights,
    );
  }

  private policyDecision(name: JevCommandName, cmd: JevCommand, result: SystemOneResult): unknown {
    const answers = result.answers;
    if (name.startsWith("publication-"))
      return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, yes(value, key)]));
    if (name === "relevance") {
      const score = normalized(answers.relevance as ScoreAnswer);
      return { score, passed: score >= Number(cmd.policy.relevance_min ?? 0.45) };
    }
    if (name === "worth-attention") {
      const score = yes(answers.worth, "worth");
      return {
        score,
        passed: score >= Number(cmd.policy.worth_min ?? 0.35),
        novelty: normalized(answers.novelty as ScoreAnswer),
      };
    }
    if (name === "importance") return { score: normalized(answers.importance as ScoreAnswer) };
    if (name === "hfs") return rankHfs(answers, cmd.policy as never);
    if (name === "claim-support")
      return Object.fromEntries(
        Object.entries(answers).map(([key, value]) => [
          key,
          { score: yes(value, key), supported: yes(value, key) >= 0.7 },
        ]),
      );
    const verdict = Object.fromEntries(
      ["same", "development", "covered", "addition", "sufficient"].map((key) => [
        key,
        yes(answers[key], key),
      ]),
    ) as any;
    const thresholds = Object.fromEntries(
      Object.entries(STORY_THRESHOLDS).map(([key, value]) => [key, cmd.policy[key] ?? value]),
    ) as typeof STORY_THRESHOLDS;
    return { verdict, action: storyAction(verdict, thresholds) };
  }

  /** Attention before an hfs classification exists: relevance, worth and novelty only. */
  preAttention(relevance: number, worth: number, novelty: number): number {
    const policy = evaluation(this.deps.store)?.value.policy.preAttention ?? POLICY_V1.preAttention;
    return Math.round(
      (relevance * policy.relevance + worth * policy.worth + novelty * policy.novelty) * 100,
    );
  }
}
