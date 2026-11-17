import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { hash, readJson, writeJson, loadTasks, root } from "./protocol.mjs";

export function redact(value) {
  if (typeof value === "string") return value
    .replace(/\b(?:sk-or-v1-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/[^\s"<>]+/g, (url) => { try { const u = new URL(url); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.toString(); } catch { return "[REDACTED_URL]"; } });
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !/api.?key|password|authorization|cookie|secret/i.test(k)).map(([k,v]) => [k,redact(v)]));
  return value;
}
const rows = (file) => readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
const saveRows = (file, data) => writeFileSync(file, data.map(JSON.stringify).join("\n") + "\n");
function newDir(out) { if (existsSync(out)) throw Error("Output exists: immutable versions require a new directory"); mkdirSync(out, {recursive:true}); }
export function capture(input, review, out) {
  const summary = readJson(join(input,"summary.json"));
  const reviewed = review ? readJson(join(review,"summary.json")) : null;
  if (reviewed && resolve(reviewed.sourceExperiment) !== resolve(input)) {
    const manifest=readJson(join(input,"manifest.json")),provenance=readJson(join(review,"provenance.json"));
    if(!manifest.inputsHash||provenance.originalInputsHash!==manifest.inputsHash)throw Error("Review belongs to a different experiment");
    for(const row of summary.results){const i=summary.results.indexOf(row),packet=readJson(join(review,`case-${i+1}.json`));const frozen=readJson(join(input,row.artifact,"input.json")),observed=readJson(join(input,row.artifact,"observed.json"));if(packet.taskId!==row.taskId||packet.artifactHash!==hash(JSON.stringify({frozen,observed})))throw Error("Relocated artifact mismatch");}
  }
  const seen = new Set(), queue=[];
  for (const row of summary.results) {
    const grade = reviewed?.results.find((r)=>r.taskId===row.taskId && r.trial===row.trial) ?? row;
    if (grade.outcome === "passed") continue;
    const dir = resolve(input,row.artifact), rel=relative(resolve(input),dir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Artifact outside input");
    const frozen=readJson(join(dir,"input.json"));
    const packet=redact({task:frozen.task,documents:frozen.documents,observed:readJson(join(dir,"observed.json")),score:grade});
    for(const d of packet.documents){if(hash(d.body)!==d.hash){d.originalBodyHash=d.hash;d.hash=hash(d.body);d.redactionApplied=true;}}
    const fingerprint=hash(JSON.stringify({task:packet.task,documents:packet.documents}));
    if(seen.has(fingerprint))continue;seen.add(fingerprint);
    queue.push({caseId:fingerprint.slice(0,24),fingerprint,sourceHash:hash(JSON.stringify(frozen)),status:"awaiting_review",usage:"development_candidate",partitionGroup:packet.task.taskId,humanReviewed:false,packet});
  }
  newDir(out);saveRows(join(out,"queue.jsonl"),queue);writeJson(join(out,"manifest.json"),{schemaVersion:1,cases:queue.length,automaticPromotion:false,redaction:"pattern_based_requires_review",sourceExperiment:resolve(input),sourceReview:review?resolve(review):null});return queue;
}
export function promote(input, decisions, out) {
  const queue=rows(join(input,"queue.jsonl")), reviews=rows(decisions), accepted=[];
  const used=new Set();
  for(const review of reviews){
    if(used.has(review.caseId))throw Error("Duplicate review");used.add(review.caseId);
    const c=queue.find((c)=>c.caseId===review.caseId);
    if(!c || review.fingerprint!==c.fingerprint || !["accept","reject"].includes(review.decision) || review.origin!=="model_assisted" || !review.reviewer || !review.rationale || review.privacyChecked!==true)throw Error("Incomplete review, provenance or privacy check");
    if(review.decision==="reject")continue;
    if(!review.key?.requiredFacts?.length || !review.key.referenceEvidence?.length || review.key.taskId!==c.packet.task.taskId)throw Error("Reviewed task key required");
    const docs=c.packet.documents;
    for(const ref of review.key.referenceEvidence){const d=docs.find((d)=>d.sampleId===ref.sampleId);const e=ref.evidence;if(!d||hash(d.body)!==d.hash||d.hash!==ref.snapshotHash||[...d.body].slice(e.startCodePoint,e.endCodePoint).join("")!==e.quote)throw Error("Reviewed citation invalid after redaction");}
    accepted.push({...c,status:"regression",review:{...review,humanReviewed:false},key:review.key});
  }
  if(!accepted.length)throw Error("No accepted cases");
  newDir(out);saveRows(join(out,"regressions.jsonl"),accepted);
  const corpus=join(out,"corpus"),labels=join(out,"labels");mkdirSync(corpus);mkdirSync(labels);
  const docs=new Map();for(const c of accepted)for(const d of c.packet.documents){if(docs.has(d.sampleId)&&JSON.stringify(docs.get(d.sampleId))!==JSON.stringify(d))throw Error("Conflicting source versions");docs.set(d.sampleId,d);}
  const splits=new Map();for(const c of accepted)for(const d of c.packet.documents){if(splits.has(d.sampleId)&&splits.get(d.sampleId)!==c.packet.task.legacySplit)throw Error("Source shared across partitions");splits.set(d.sampleId,c.packet.task.legacySplit);}
  saveRows(join(corpus,"samples.jsonl"),[...docs.values()].map(d=>({id:d.sampleId,snapshotId:d.id,url:d.url,title:d.title,publishedAt:d.publishedAt,split:splits.get(d.sampleId),cluster:d.cluster})));
  saveRows(join(corpus,"snapshots.jsonl"),[...docs.values()]);saveRows(join(labels,"tasks.jsonl"),accepted.map(c=>({...c.packet.task,humanReviewed:false,usage:"exposed_diagnostic"})));
  saveRows(join(labels,"task-keys.jsonl"),accepted.map(c=>({...c.key,humanReviewed:false,labelOrigin:"model_assisted"})));
  loadTasks(corpus,labels);
  writeJson(join(out,"experiment.json"),{corpus:relative(root,corpus).replaceAll("\\","/"),labels:relative(root,labels).replaceAll("\\","/"),model:"deepseek-flash",researchModel:"deepseek-flash",provider:"deepseek",backend:"fixture",budgetScope:"openrouter-credits",researchCandidates:2,repeats:1});
  writeJson(join(out,"manifest.json"),{schemaVersion:1,cases:accepted.length,usage:"exposed_development_regression",humanReviewed:false,sourceQueue:resolve(input)});return accepted;
}
export function track(version, experiment, review, out){
  const cases=rows(join(version,"regressions.jsonl")),s=readJson(join(experiment,"summary.json")),r=readJson(join(review,"summary.json"));
  if(resolve(r.sourceExperiment)!==resolve(experiment))throw Error("Review source mismatch");
  const results=cases.map((c)=>{const trials=r.results.filter((x)=>x.taskId===c.packet.task.taskId);const executed=s.results.filter(x=>x.taskId===c.packet.task.taskId);const expected=c.packet.documents.map(d=>d.hash).sort();const sameInputs=executed.length===trials.length&&executed.every(x=>{const frozen=readJson(join(experiment,x.artifact,"input.json"));return JSON.stringify(frozen.documents.map(d=>d.hash).sort())===JSON.stringify(expected)&&frozen.task.goal===c.packet.task.goal;});return {caseId:c.caseId,taskId:c.packet.task.taskId,status:!trials.length?"not_exercised":!sameInputs?"input_mismatch":trials.some(x=>x.outcome==="needs_review"||x.reviewStatus==="awaiting_review")?"awaiting_review":s.status==="completed"&&trials.every((x)=>x.outcome==="passed")?"resolved_in_this_run":"recurred",trials:trials.length};});
  newDir(out);writeJson(join(out,"tracking.json"),{humanReviewed:false,sourceVersion:resolve(version),sourceExperiment:resolve(experiment),sourceCommit:s.settings?.source??null,results});return results;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const {values:a}=parseArgs({options:{action:{type:"string"},input:{type:"string"},review:{type:"string"},decisions:{type:"string"},experiment:{type:"string"},out:{type:"string"}}});
  if(!a.input||!a.out)throw Error("Specify --input --out");
  const result=a.action==="capture"?capture(resolve(a.input),a.review&&resolve(a.review),resolve(a.out)):a.action==="promote"?promote(resolve(a.input),resolve(a.decisions),resolve(a.out)):a.action==="track"?track(resolve(a.input),resolve(a.experiment),resolve(a.review),resolve(a.out)):(()=>{throw Error("Unknown action")})();console.log(JSON.stringify({count:result.length}));
}
