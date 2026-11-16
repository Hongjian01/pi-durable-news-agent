/** Verify a non-resetting supplier budget without confusing credits with BYOK spend. */
export function verifyOpenRouterBudget(data, maxUsd, scope = "including-byok") {
  if (!["including-byok", "openrouter-credits"].includes(scope))
    throw Error("Unknown --budget-scope: use including-byok or openrouter-credits");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    throw Error("--max-usd must be a finite positive number");
  const includes = (value) => scope === "openrouter-credits" || value === true;
  const budgets = [
    ...(data.budgets ?? [])
      .filter((b) => includes(b.include_byok) && b.reset_interval === null)
      .map((b) => b.remaining_usd),
  ];
  if (includes(data.include_byok_in_limit) && data.limit_reset === null)
    budgets.push(data.limit_remaining);
  if (!budgets.some((n) => Number.isFinite(n) && n > 0 && n <= maxUsd))
    throw Error(
      "OpenRouter budget check failed: require positive remaining budget within --max-usd, " +
        "no reset, and BYOK included unless --budget-scope openrouter-credits is selected. " +
        "Budget fields (no API key): " +
        JSON.stringify({
          maxUsd,
          scope,
          limit: data.limit ?? null,
          limit_remaining: data.limit_remaining ?? null,
          limit_reset: data.limit_reset ?? null,
          include_byok_in_limit: data.include_byok_in_limit ?? null,
          budgets: (data.budgets ?? []).map((b) => ({
            remaining_usd: b.remaining_usd ?? null,
            reset_interval: b.reset_interval ?? null,
            include_byok: b.include_byok ?? null,
          })),
        }),
    );
}
