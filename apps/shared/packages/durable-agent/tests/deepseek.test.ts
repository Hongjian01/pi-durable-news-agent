import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelCatalog } from "../src/models.ts";

test("DeepSeek catalog uses official provider IDs and preserves tool reasoning compatibility", () => {
  const catalog = createModelCatalog({ provider: "deepseek" });
  assert.deepEqual(catalog.defaultModel, { provider: "deepseek", modelId: "deepseek-flash" });
  assert.deepEqual(catalog.ref("deepseek-v4-pro"), {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  assert.throws(() => catalog.ref("deepseek/deepseek-v4-pro"), /Unknown DeepSeek model/);
  const model = catalog.models.getModel("deepseek", "deepseek-flash");
  assert.equal(model?.baseUrl, "https://api.deepseek.com");
  assert.equal(model?.api, "openai-completions");
  assert.ok(
    catalog.list().every((entry) => entry.provider === "deepseek" && entry.contextWindow > 0),
  );
});
