import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const MODEL_OUTPUT_POLICY = {
  version: 1,
  deepseekNonThinkingAtOrBelow: 2000,
} as const;

/** DeepSeek reasoning shares max_tokens with tool arguments. Small tool budgets need non-thinking mode. */
export function cappedModelOptions(
  model: { provider: string },
  options: SimpleStreamOptions = {},
  outputLimit: number,
  policy = MODEL_OUTPUT_POLICY,
): SimpleStreamOptions {
  const maxTokens = Math.min(options.maxTokens ?? 2000, outputLimit);
  return {
    ...options,
    ...(model.provider === "deepseek" && maxTokens <= policy.deepseekNonThinkingAtOrBelow
      ? { reasoning: undefined }
      : {}),
    maxTokens,
    maxRetries: 0,
  };
}
