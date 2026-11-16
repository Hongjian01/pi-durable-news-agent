import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { ref } from "./shared.ts";
import { execution } from "../../db/execution.ts";
import { tx } from "../../db/db.ts";
import { assessClaims } from "../../news/evidence.ts";

const ACTIONABILITY = ["high", "medium", "low", "none"] as const;

export function reportFindings(deps: Deps) {
  return defineAppTool({
    name: "report_findings",
    returns: "Text: that the findings were saved, with how many claims jev found supported.",
    description:
      "Save your findings for one item: a one sentence summary, up to four claims, evidence urls, and actionability. Claims are checked against the item text with jev claim-support unless you already did.",
    parameters: Type.Object({
      item_id: Type.Integer(),
      summary: Type.String({ minLength: 10, maxLength: 600 }),
      claims: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 5 }),
      citations: Type.Optional(
        Type.Array(
          Type.Object({
            claim_index: Type.Integer({ minimum: 0, maximum: 4 }),
            snapshot_id: Type.Integer(),
            quote: Type.String({ minLength: 1, maxLength: 2000 }),
            start: Type.Optional(
              Type.Integer({
                minimum: 0,
                description:
                  "Optional exact UTF-16 offset. Omit start and end for a unique exact quote; the server resolves them. Never guess.",
              }),
            ),
            end: Type.Optional(
              Type.Integer({
                minimum: 1,
                description:
                  "Optional exclusive UTF-16 end offset. Omit together with start unless known exactly.",
              }),
            ),
            body_hash: Type.Optional(Type.String()),
          }),
          { maxItems: 15 },
        ),
      ),
      evidence_urls: Type.Array(Type.String(), { maxItems: 6 }),
      actionability: Type.Union(ACTIONABILITY.map((a) => Type.Literal(a))),
    }),
    enums: { actionability: ACTIONABILITY },
    example: {
      item_id: 12,
      summary: "v2.4 adds durable sessions; available now.",
      claims: ["Version 2.4 is available"],
      evidence_urls: ["https://example.com/release"],
      actionability: "medium",
    },
    replay: "safe",
    execute: async (args, api) => {
      const scope = execution.getStore();
      const prior = scope
        ? deps.store.db.prepare("SELECT id FROM research_reports WHERE task_id=?").get(api.taskId)
        : undefined;
      if (prior)
        return toolText("Research report already saved; original claims and snapshots preserved.");
      const item = deps.store.news.item(args.item_id);
      if (!item)
        return toolError(`No item #${args.item_id}.`, ["Report only the item ids you were given."]);
      const cached = item.cacheId ? deps.store.sources.cachedById(item.cacheId) : undefined;
      const evidence = cached?.contentMd ?? item.excerpt ?? item.title;
      let support: { claim: string; supported: number; status?: string }[] = [];
      const assessed = scope
        ? await assessClaims(
            deps,
            scope.sweepId,
            item.id,
            args.claims,
            args.citations ?? [],
            args.evidence_urls,
          )
        : undefined;
      if (assessed)
        support = assessed
          .filter((c) => c.score !== null)
          .map((c) => ({ claim: c.text, supported: c.score!, status: c.status }));
      const invalidCitations =
        assessed?.flatMap((claim, index) =>
          claim.reason === "no_valid_source_quote" ? [index] : [],
        ) ?? [];
      if (invalidCitations.length)
        return toolError(
          `report_findings rejected: invalid or missing source quote for claim_index ${invalidCitations.join(", ")}. No findings were saved.`,
          [
            "Copy an exact quote from read_item or scrape_url and use its snapshot_id, body_hash and evidence URL.",
            "For a unique exact quote, OMIT both start and end; the server computes UTF-16 offsets. Never guess character positions. Repeated quotes require exact disambiguating offsets.",
            "Correct citations and retry report_findings. To abstain when no source supports any claim, submit claims: [] and citations: [].",
          ],
        );
      if (args.claims.length && !scope) {
        try {
          support = await deps.judge.claimSupport(args.claims, evidence, {
            ...ref(api, item.sweepId),
            itemId: item.id,
          });
        } catch (error) {
          deps.log.warn("findings.claim_support_failed", { itemId: item.id, error: String(error) });
          if (execution.getStore()) throw error;
        }
      }
      tx(deps.store.db, () => {
        const finding = deps.store.news.addFinding({
          itemId: item.id,
          conversationId: api.conversationId as number,
          summary: args.summary,
          claims: args.claims,
          evidence: args.evidence_urls,
          actionability: args.actionability,
          claimSupport: support,
        });
        if (scope) {
          const reportId = Number(
            deps.store.db
              .prepare(
                "INSERT INTO research_reports(sweep_id,item_id,task_id,finding_id,artifact_json,created_at) VALUES (?,?,?,?,?,?)",
              )
              .run(
                scope.sweepId,
                item.id,
                api.taskId,
                finding.id,
                JSON.stringify({ summary: args.summary, claims: args.claims, assessed }),
                new Date().toISOString(),
              ).lastInsertRowid,
          );
          for (const [index, claim] of assessed!.entries()) {
            const claimId = Number(
              deps.store.db
                .prepare(
                  "INSERT INTO claims(report_id,claim_index,text,status,score,operation_key,reason) VALUES (?,?,?,?,?,?,?)",
                )
                .run(
                  reportId,
                  index,
                  claim.text,
                  claim.status,
                  claim.score,
                  claim.operationKey ?? null,
                  claim.reason ?? null,
                ).lastInsertRowid,
            );
            for (const e of claim.evidence)
              deps.store.db
                .prepare(
                  "INSERT INTO claim_evidence(claim_id,snapshot_id,body_hash,quote,start_offset,end_offset,validation_status) VALUES (?,?,?,?,?,?,?)",
                )
                .run(
                  claimId,
                  e.snapshot.id,
                  e.snapshot.body_hash,
                  e.quote,
                  e.start,
                  e.end,
                  e.valid ? "valid" : "invalid",
                );
          }
          deps.store.db
            .prepare("UPDATE sweep_items SET report_id=? WHERE sweep_id=? AND item_id=?")
            .run(reportId, scope.sweepId, item.id);
          const insufficient = !assessed!.some((claim) => claim.status === "supported");
          deps.store.lifecycle.item(scope.sweepId, item.id, {
            findingId: finding.id,
            researchStatus: "completed",
            ...(insufficient
              ? {
                  disposition: "insufficient_evidence",
                  reason: "No supported factual claims in the supplied source",
                }
              : {}),
          });
          deps.store.lifecycle.progress(scope.sweepId);
        }
      });
      const supported = assessed ? assessed.filter((c) => c.status === "supported").length : support.filter((s) => s.supported >= 0.7).length;
      const unresolved = assessed?.filter((c) => c.status !== "supported") ?? [];
      return toolText(
        `Saved findings for #${item.id}${args.claims.length ? `: ${supported} of ${args.claims.length} claims supported` : ""}.${unresolved.length ? `\nNot verified: ${JSON.stringify(unresolved.map((c) => ({ claim: c.text, status: c.status })))}. Do not publish these as established facts. If required to answer the user, submit a new corrected report with direct quotes covering every facet, or abstain.` : ""}`,
      );
    },
  });
}
