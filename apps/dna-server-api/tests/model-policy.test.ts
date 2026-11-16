import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelCatalog } from "@dna/durable-agent";
import { cappedModelOptions } from "../src/news/model-policy.ts";

test("DeepSeek short tool budget serializes thinking disabled before any HTTP request", async () => {
  const catalog = createModelCatalog({ provider: "deepseek" });
  const model = {
    ...catalog.models.getModel("deepseek", "deepseek-flash")!,
    baseUrl: "http://127.0.0.1:1",
  };
  let payload: any;
  const result = await catalog.models.completeSimple(
    model,
    {
      messages: [
        { role: "user", content: "Read source, then submit findings.", timestamp: Date.now() },
      ],
    },
    cappedModelOptions(
      model,
      {
        apiKey: "offline-test-not-a-real-key",
        reasoning: "low",
        maxTokens: 8000,
        onPayload(value) {
          payload = value;
          throw new Error("offline-payload-capture");
        },
      },
      2000,
    ),
  );
  assert.ok(payload, "SDK should construct request before the capture stops it");
  assert.deepEqual(payload.thinking, { type: "disabled" });
  assert.equal(payload.max_tokens, 2000);
  assert.match(result.errorMessage ?? "", /offline-payload-capture/);
});

test("other providers and larger DeepSeek budgets preserve requested reasoning and tighter token caps", () => {
  assert.equal(
    cappedModelOptions({ provider: "openrouter" }, { reasoning: "low" }, 2000).reasoning,
    "low",
  );
  assert.equal(
    cappedModelOptions({ provider: "deepseek" }, { reasoning: "low", maxTokens: 8000 }, 8000)
      .reasoning,
    "low",
  );
  assert.equal(
    cappedModelOptions({ provider: "deepseek" }, { reasoning: "low", maxTokens: 1000 }, 2000)
      .maxTokens,
    1000,
  );
});
