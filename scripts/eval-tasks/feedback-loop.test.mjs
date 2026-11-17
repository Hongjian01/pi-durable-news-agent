import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, promote, capture, track } from "./feedback-loop.mjs";
import { hash, loadTasks } from "./protocol.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("feedback redaction strips credentials, PII and query secrets recursively", () => {
  const r = redact({
    api_key: "secret",
    body: "person@example.com https://user:pass@example.com/a?token=secret Bearer abc123",
    nested: ["sk-or-v1-abcdefghijklmnopqrst"],
  });
  assert.equal(r.api_key, undefined);
  assert.doesNotMatch(JSON.stringify(r), /person@|user:pass|token=secret|abc123|abcdefghijkl/);
});

test("production negative feedback is durably queued by migration without copying private notes",()=>{
 const db=new DatabaseSync(":memory:");try{db.exec("CREATE TABLE feedback(id INTEGER PRIMARY KEY,signal TEXT,note TEXT,created_at TEXT);INSERT INTO feedback VALUES(1,'less','private note','2026-01-01');");
 db.exec(readFileSync(new URL("../../apps/dna-server-api/src/db/migrations/006_feedback_regression_queue.sql",import.meta.url),"utf8"));
 db.exec("INSERT INTO feedback VALUES(2,'more',NULL,'2026-01-01');INSERT INTO feedback VALUES(3,'less',NULL,'2026-01-01');");
 assert.deepEqual(db.prepare("SELECT feedback_id FROM feedback_regression_queue ORDER BY feedback_id").all().map(r=>r.feedback_id),[1,3]);
 assert.equal(db.prepare("PRAGMA table_info(feedback_regression_queue)").all().some(r=>r.name==="note"),false);
 }finally{db.close();}
});

test("reviewed feedback compiles into an executable version and tracks pending versus resolved trials", () => {
  const base=mkdtempSync(join(tmpdir(),"feedback-positive-"));
  try {
    const input=join(base,"run"),trial=join(input,"trial"),review=join(base,"review");mkdirSync(trial,{recursive:true});mkdirSync(review);
    const body="A snapshot can resume.",doc={id:"snapshot-a",sampleId:"sample-a",url:"https://example.dev/a",title:"A",body,hash:hash(body),publishedAt:"2026-01-01T00:00:00Z",fetchedAt:"2026-01-01T00:00:00Z",truncated:false};
    const task={taskId:"feedback-a",goal:"Check resume",referenceTime:doc.fetchedAt,maxCards:1,legacySplit:"dev",candidateIds:[doc.sampleId]};
    const write=(file,value)=>writeFileSync(file,JSON.stringify(value));
    write(join(trial,"input.json"),{task,documents:[doc]});write(join(trial,"observed.json"),{});write(join(input,"summary.json"),{status:"completed",results:[{taskId:task.taskId,trial:1,artifact:"trial",outcome:"failed"}]});
    const queue=join(base,"queue"),c=capture(input,null,queue)[0],decisions=join(base,"decisions.jsonl");
    write(decisions,{caseId:c.caseId,fingerprint:c.fingerprint,decision:"accept",origin:"model_assisted",reviewer:"test",rationale:"Known-source regression",privacyChecked:true,key:{taskId:task.taskId,requiredFacts:["Snapshot can resume"],referenceEvidence:[{sampleId:doc.sampleId,snapshotId:doc.id,snapshotHash:doc.hash,evidence:{quote:body,startCodePoint:0,endCodePoint:body.length}}]}});
    const version=join(base,"v1");promote(queue,decisions,version);assert.equal(loadTasks(join(version,"corpus"),join(version,"labels")).length,1);
    write(join(review,"summary.json"),{sourceExperiment:input,results:[{taskId:task.taskId,outcome:"needs_review",reviewStatus:"awaiting_review"}]});
    assert.equal(track(version,input,review,join(base,"track-pending"))[0].status,"awaiting_review");
    write(join(review,"summary.json"),{sourceExperiment:input,results:[{taskId:task.taskId,outcome:"passed",reviewStatus:"evaluated"}]});
    assert.equal(track(version,input,review,join(base,"track-resolved"))[0].status,"resolved_in_this_run");
  } finally {rmSync(base,{recursive:true,force:true});}
});
test("reviewed successes are excluded; promotion rejects unreviewed or stale decisions", () => {
  const base = mkdtempSync(join(tmpdir(), "feedback-loop-"));
  try {
    const input = join(base, "run");
    mkdirSync(input);
    mkdirSync(join(input, "trial"));
    const write = (file, v) => writeFileSync(file, JSON.stringify(v));
    write(join(input, "summary.json"), {
      results: [{ taskId: "one", trial: 1, outcome: "needs_review", artifact: "trial" }],
    });
    write(join(input, "trial/input.json"), { task: { taskId: "one" }, documents: [] });
    write(join(input, "trial/observed.json"), {});
    const review = join(base, "review");
    mkdirSync(review);
    write(join(review, "summary.json"), {
      sourceExperiment: input,
      results: [{ taskId: "one", trial: 1, outcome: "passed" }],
    });
    assert.equal(capture(input, review, join(base, "empty")).length, 0);
    const q = capture(input, null, join(base, "queue"));
    writeFileSync(
      join(base, "decisions.jsonl"),
      JSON.stringify({ caseId: q[0].caseId, fingerprint: "stale", decision: "accept" }),
    );
    assert.throws(
      () => promote(join(base, "queue"), join(base, "decisions.jsonl"), join(base, "v1")),
      /Incomplete review/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
