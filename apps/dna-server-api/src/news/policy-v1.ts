/** Existing upstream values, extracted without tuning. Command-specific policy
 * remains in the six command.json files and is frozen with this configuration. */
export const POLICY_V1 = {
  version: "policy-v1",
  gate: { relevanceMin: 0.45, worthMin: 0.35 },
  preAttention: { relevance: 0.5, worth: 0.35, novelty: 0.15 },
  freshness: { hours: [24, 72, 168], factors: [1, 0.85, 0.7, 0.55], undatedHours: 48 },
  claimSupportMin: 0.7,
  evidence: {
    version: "evidence-v1",
    sufficientMin: 0.8,
    conflictingMin: 0.8,
    unsupportedMax: 0.2,
  },
} as const;
