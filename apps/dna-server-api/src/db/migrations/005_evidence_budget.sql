-- Legacy cached bodies have no trustworthy extraction completeness metadata.
ALTER TABLE source_cache ADD COLUMN truncated INTEGER NOT NULL DEFAULT 1;
CREATE TABLE source_snapshots (
 id INTEGER PRIMARY KEY,url TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL,
 fetched_at TEXT NOT NULL,extract_version TEXT NOT NULL,title TEXT,truncated INTEGER NOT NULL DEFAULT 0,
 UNIQUE(url,body_hash,extract_version)
);
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON source_snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON source_snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot'); END;
CREATE TABLE sweep_snapshots (
 sweep_id INTEGER NOT NULL REFERENCES sweeps(id),url TEXT NOT NULL,snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id),
 PRIMARY KEY(sweep_id,url)
);
CREATE TRIGGER snapshot_binding_no_update BEFORE UPDATE ON sweep_snapshots BEGIN SELECT RAISE(ABORT,'immutable snapshot binding'); END;
CREATE TABLE research_reports (
 id INTEGER PRIMARY KEY,sweep_id INTEGER NOT NULL REFERENCES sweeps(id),item_id INTEGER NOT NULL REFERENCES items(id),
 task_id INTEGER NOT NULL UNIQUE,finding_id INTEGER NOT NULL REFERENCES findings(id),artifact_json TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TRIGGER reports_no_update BEFORE UPDATE ON research_reports BEGIN SELECT RAISE(ABORT,'immutable research report'); END;
ALTER TABLE sweep_items ADD COLUMN report_id INTEGER REFERENCES research_reports(id);
CREATE TABLE claims (
 id INTEGER PRIMARY KEY,report_id INTEGER NOT NULL REFERENCES research_reports(id),claim_index INTEGER NOT NULL,text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('not_evaluated','supported','unsupported','insufficient','conflicting')),
 score REAL,operation_key TEXT REFERENCES judgment_operations(operation_key),reason TEXT,
 UNIQUE(report_id,claim_index)
);
CREATE TABLE claim_evidence (
 id INTEGER PRIMARY KEY,claim_id INTEGER NOT NULL REFERENCES claims(id),snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id),
 body_hash TEXT NOT NULL,quote TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,
 validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','invalid'))
);
CREATE TRIGGER claims_no_update BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT,'immutable claim'); END;
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON claim_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
CREATE TABLE budget_reservations (
 id INTEGER PRIMARY KEY,sweep_id INTEGER NOT NULL REFERENCES sweeps(id),kind TEXT NOT NULL,operation_key TEXT NOT NULL,
 item_ids_json TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'unknown',cost_usd REAL,cost_source TEXT NOT NULL DEFAULT 'unknown',
 requested_model TEXT,resolved_model TEXT,input_tokens INTEGER,output_tokens INTEGER,created_at TEXT NOT NULL,settled_at TEXT
);
CREATE INDEX reservations_sweep_kind ON budget_reservations(sweep_id,kind);
CREATE TABLE budget_denials(sweep_id INTEGER NOT NULL REFERENCES sweeps(id),kind TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE research_conversations(conversation_id INTEGER PRIMARY KEY,sweep_id INTEGER NOT NULL REFERENCES sweeps(id),epoch INTEGER NOT NULL,item_ids_json TEXT NOT NULL,deadline_at INTEGER NOT NULL);
