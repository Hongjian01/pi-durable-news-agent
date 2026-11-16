// The quick model: one-shot jobs (reading a publish date out of a page today) on a small, cheap model the reader picks
// next to the agent's model. Saved in settings; Haiku 5.5 with thinking off by default.
import type { ModelCatalog } from "@dna/durable-agent";
import type { Logger } from "@dna/sdk/node";
import type { Store } from "../db/store.ts";
import { evaluation } from "./context.ts";
import { estimatedModelCost } from "./budgets.ts";

export const QUICK_THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export type QuickThinking = (typeof QUICK_THINKING)[number];

export interface QuickSetting {
  model: string;
  thinkingLevel: QuickThinking;
}

export const DEFAULT_QUICK: QuickSetting = {
  model: "anthropic/claude-haiku-5.5",
  thinkingLevel: "off",
};

export class Quick {
  constructor(private readonly deps: { catalog: ModelCatalog; store: Store; log: Logger }) {}

  setting(): QuickSetting {
    const defaults = {
      ...DEFAULT_QUICK,
      model:
        this.deps.catalog.provider === "deepseek"
          ? this.deps.catalog.defaultModel.modelId
          : DEFAULT_QUICK.model,
    };
    return { ...defaults, ...this.deps.store.settings.get("quick", defaults) };
  }

  set(patch: Partial<QuickSetting>): QuickSetting {
    const next = { ...this.setting(), ...patch };
    this.deps.store.settings.set("quick", next);
    this.deps.log.info("quick.configured", { ...next });
    return next;
  }

  /** One system prompt, one user message, the reply's text. Throws on provider errors. */
  async ask(
    label: string,
    system: string,
    user: string,
  ): Promise<{ text: string; costUsd: number | null }> {
    const { model: id, thinkingLevel } =
      evaluation(this.deps.store)?.value.models.quick ?? this.setting();
    const { catalog, log } = this.deps;
    const ref = catalog.ref(id);
    const model = catalog.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`The quick model ${id} is not available`);
    const started = Date.now();
    const reply = await catalog.models.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: started }] },
      {
        maxTokens: 400,
        signal: AbortSignal.timeout(30_000),
        ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
      },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(reply.errorMessage ?? `The quick model stopped: ${reply.stopReason}`);
    const text = reply.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    const costUsd = catalog.provider === "faux" ? 0 : estimatedModelCost(model, reply.usage);
    log.info("quick.call", {
      label,
      model: id,
      input: reply.usage?.input,
      output: reply.usage?.output,
      costUsd,
      ms: Date.now() - started,
    });
    return { text, costUsd };
  }
}
