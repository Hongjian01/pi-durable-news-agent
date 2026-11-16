import { parseArgs } from "node:util";
import { JevClient, noul } from "../../apps/shared/packages/jev/src/index.ts";
import { verifyOpenRouterBudget } from "./budget.mjs";

const { values: a } = parseArgs({
  options: {
    "enable-paid": { type: "boolean" },
    "max-usd": { type: "string" },
    "budget-scope": { type: "string" },
    help: { type: "boolean" },
  },
});
if (a.help) {
  console.log(
    "eval:jev-check: without --enable-paid, reads safe key budget fields only. With --enable-paid --max-usd N [--budget-scope openrouter-credits], sends exactly one small Jev request, with no DeepSeek calls or retries.",
  );
} else {
  try {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw Error("OPENROUTER_API_KEY is missing");
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Key metadata HTTP " + response.status);
    const { data } = await response.json();
    console.log(
      JSON.stringify(
        {
          limit: data.limit,
          limit_remaining: data.limit_remaining,
          limit_reset: data.limit_reset,
          include_byok_in_limit: data.include_byok_in_limit,
          is_management_key: data.is_management_key,
          expires_at: data.expires_at,
        },
        null,
        2,
      ),
    );
    if (!a["enable-paid"])
      console.log("No model request sent. Add --enable-paid and --max-usd to probe Jev once.");
    else {
      verifyOpenRouterBudget(data, Number(a["max-usd"]), a["budget-scope"] ?? "including-byok");
      const client = new JevClient({ provider: "openrouter", maxAttempts: 1 });
      const result = await client.systemOne(
        { text: "Tool selection does not grant execution permission." },
        {
          stated: noul(
            "Does text explicitly state that tool selection does not grant execution permission?",
          ),
        },
      );
      console.log(
        JSON.stringify(
          {
            status: "ok",
            model: result.meta.resolvedModel,
            cost: result.meta.cost,
            answers: result.answers,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          status: "failed",
          httpStatus: error.status,
          providerCode: error.providerCode,
          limitSource: error.limitSource,
          message: error.message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
