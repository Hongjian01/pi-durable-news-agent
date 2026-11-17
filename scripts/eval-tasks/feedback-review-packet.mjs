import { redact } from "./feedback-loop.mjs";

/** Select complete cited source bodies, never a silent character prefix. The
 * reviewer may reject an unanswerable subset; the regression retains all inputs. */
export function reviewPacket(candidate) {
  const packet = candidate.packet;
  const sources = (packet.observed?.cards ?? []).flatMap((card) =>
    (card.props?.verifiedClaims ?? []).flatMap((claim) => claim.sources ?? []),
  );
  const cited = packet.documents.filter((doc) =>
    sources.some(
      (source) =>
        source.url === doc.url && [doc.hash, doc.originalBodyHash].includes(source.bodyHash),
    ),
  );
  const documents = cited.length ? cited : packet.documents;
  const payload = redact({
    task: packet.task,
    documents: documents.map((doc) => ({ sampleId: doc.sampleId, body: doc.body })),
    evidenceScope: {
      selection: cited.length ? "complete_cited_documents" : "complete_candidate_pool",
      supplied: documents.length,
      available: packet.documents.length,
      truncated: false,
    },
    feedback: packet.feedback,
  });
  if (JSON.stringify(payload).length > 150000)
    throw Error(
      "Complete review sources exceed input budget; curate sources explicitly, never silently truncate",
    );
  return payload;
}
