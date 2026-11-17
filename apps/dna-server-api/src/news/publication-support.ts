import { yes } from "@dna/jev";
import type { Deps } from "../deps.ts";
import { evaluation } from "./context.ts";
import { supportedClaims } from "./evidence.ts";

export async function publicationSupportGap(deps: Deps, sweepId: number, itemId: number, component: string, props: Record<string, unknown>): Promise<string | undefined> {
  const context = evaluation(deps.store, sweepId)?.value;
  if (context?.strategy.selectionMode !== "evidence") return;
  const command = context.commands["publication-support"];
  const enforce = command?.policy.enforcement === "enforce";
  // Uncalibrated semantics must not create an endless repair loop. Retain one
  // diagnostic per item; deterministic evidence rules and final CI remain strict.
  if (!enforce && deps.store.db.prepare("SELECT 1 FROM judgment_operations WHERE sweep_id=? AND item_id=? AND command IN ('publication-support','publication-relevance','publication-grounding') LIMIT 1").get(sweepId, itemId)) return;
  const goal = context.keywords.filter((k) => k.kind === "topic" && k.enabled).map((k) => k.term).join("\n");
  const claims = supportedClaims(deps, sweepId, itemId);
  if (!goal || !claims.length) return enforce ? "publication_support_missing: no question or validated claims" : undefined;
  // These server-owned fields can never be supplied by the agent to certify itself.
  const { verifiedClaims: _ignored, verificationScope: _scope, ...visible } = props;
  if (!command || !context.commands["publication-relevance"] || !context.commands["publication-grounding"]) return;
  const relevant = await deps.judge.run("publication-relevance", { goal, supportedClaims: claims }, { sweepId, itemId });
  const grounded = await deps.judge.run("publication-grounding", { card: { component, props: visible }, supportedClaims: claims }, { sweepId, itemId });
  const result = {answers: {...relevant.answers, ...grounded.answers}};
  const minimum = Number(deps.judge.command("publication-support", sweepId).policy.minimum);
  if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 1) throw Error("Invalid publication support policy");
  const gaps = ["publication_relevant", "publication_grounded"].filter((key) => yes(result.answers[key], key) < minimum);
  if (!enforce) {
    deps.log.info("publication.support_diagnostic", { sweepId, itemId, gaps, enforcement: "observe" });
    return;
  }
  return gaps.length ? `${gaps.join(",")}: compare the researched candidates against each part of the question; select direct evidence, repair citations or remove unsupported assertions, then retry. Do not bypass by rewriting the same assertion or including unverified metadata.` : undefined;
}
