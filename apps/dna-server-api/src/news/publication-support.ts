import { yes } from "@dna/jev";
import type { Deps } from "../deps.ts";
import { evaluation } from "./context.ts";
import { supportedClaims } from "./evidence.ts";

export async function publicationSupportGap(deps: Deps, sweepId: number, itemId: number, component: string, props: Record<string, unknown>): Promise<string | undefined> {
  const context = evaluation(deps.store, sweepId)?.value;
  if (context?.strategy.selectionMode !== "evidence") return;
  const goal = context.keywords.filter((k) => k.kind === "topic" && k.enabled).map((k) => k.term).join("\n");
  const claims = supportedClaims(deps, sweepId, itemId);
  if (!goal || !claims.length) return "publication_support_missing: no question or validated claims";
  // These server-owned fields can never be supplied by the agent to certify itself.
  const { verifiedClaims: _ignored, verificationScope: _scope, ...visible } = props;
  if (!context.commands["publication-support"])
    return "publication_support_unavailable: start a new sweep with the updated frozen command";
  const result = await deps.judge.run("publication-support", { goal, card: { component, props: visible }, supportedClaims: claims }, { sweepId, itemId });
  const minimum = Number(deps.judge.command("publication-support", sweepId).policy.minimum);
  if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 1) throw Error("Invalid publication support policy");
  const gaps = ["publication_relevant", "publication_grounded"].filter((key) => yes(result.answers[key], key) < minimum);
  return gaps.length ? `${gaps.join(",")}: compare the researched candidates against each part of the question; select direct evidence, repair citations or remove unsupported assertions, then retry. Do not bypass by rewriting the same assertion or including unverified metadata.` : undefined;
}
