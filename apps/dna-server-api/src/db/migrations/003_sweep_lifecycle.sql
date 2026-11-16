-- Startup-only table rebuild. migrate.ts checks duplicate cards before any DDL,
-- disables FK enforcement around this transaction and checks integrity before commit.
CREATE TABLE sweeps_next (
 id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
 trigger TEXT NOT NULL CHECK(trigger IN ('cron','manual','test')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','finalizing','cancelling','completed','no_news','partial','failed','cancelled','skipped','stalled')),
 reason TEXT, submission_id INTEGER, run_entry_id INTEGER, task_id INTEGER, search_mode TEXT,
 gathered INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0,
 duplicates INTEGER NOT NULL DEFAULT 0, candidates INTEGER NOT NULL DEFAULT 0,
 presented INTEGER NOT NULL DEFAULT 0, summary TEXT, firecrawl_credits_used REAL NOT NULL DEFAULT 0,
 firecrawl_credits_left INTEGER, phases_json TEXT, audit_json TEXT, error TEXT, max_cards INTEGER,
 started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL,
 context_id INTEGER REFERENCES evaluation_contexts(id), execution_epoch INTEGER NOT NULL DEFAULT 0,
 last_progress_at TEXT, wait_reason TEXT, next_wake_at TEXT, deadline_at TEXT,
 cancel_requested_at TEXT, failure_code TEXT, retry_of_sweep_id INTEGER REFERENCES sweeps(id)
);
INSERT INTO sweeps_next SELECT *, created_at, NULL, NULL,
 strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+24 hours'),NULL,NULL,NULL FROM sweeps;
DROP TABLE sweeps;
ALTER TABLE sweeps_next RENAME TO sweeps;
CREATE TRIGGER sweeps_legal_transition BEFORE UPDATE OF status ON sweeps
WHEN NEW.status != OLD.status AND NOT (
 (OLD.status='queued' AND NEW.status IN ('running','failed','cancelling')) OR
 (OLD.status='running' AND NEW.status IN ('finalizing','cancelling')) OR
 (OLD.status='finalizing' AND NEW.status IN ('running','completed','no_news','partial','failed','cancelling')) OR
 (OLD.status='cancelling' AND NEW.status IN ('cancelled','partial','failed'))
) BEGIN SELECT RAISE(ABORT,'illegal sweep lifecycle transition'); END;
CREATE UNIQUE INDEX cards_one_news_per_item ON cards(item_id) WHERE kind='news' AND item_id IS NOT NULL;
CREATE TABLE execution_bindings (task_id INTEGER PRIMARY KEY, sweep_id INTEGER NOT NULL REFERENCES sweeps(id), epoch INTEGER NOT NULL, research_deadline INTEGER);
CREATE TABLE sweep_items (
 sweep_id INTEGER NOT NULL REFERENCES sweeps(id), item_id INTEGER NOT NULL REFERENCES items(id),
 disposition TEXT NOT NULL DEFAULT 'pending', reason TEXT, selected INTEGER NOT NULL DEFAULT 0,
 research_status TEXT NOT NULL DEFAULT 'pending', finding_id INTEGER REFERENCES findings(id), card_id INTEGER REFERENCES cards(id),
 PRIMARY KEY(sweep_id,item_id)
);
CREATE TABLE sweep_sources (sweep_id INTEGER NOT NULL REFERENCES sweeps(id), source_key TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY(sweep_id,source_key));
CREATE TABLE sweep_finalizations (
 sweep_id INTEGER PRIMARY KEY REFERENCES sweeps(id), epoch INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', repairs INTEGER NOT NULL DEFAULT 0,
 summary TEXT NOT NULL, gaps_json TEXT, result TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE research_jobs (task_id INTEGER PRIMARY KEY, sweep_id INTEGER NOT NULL REFERENCES sweeps(id), epoch INTEGER NOT NULL, item_ids_json TEXT NOT NULL, status TEXT NOT NULL, deadline_at INTEGER NOT NULL);
CREATE TABLE publication_events (sweep_id INTEGER NOT NULL REFERENCES sweeps(id), item_id INTEGER NOT NULL REFERENCES items(id), card_id INTEGER NOT NULL REFERENCES cards(id), created INTEGER NOT NULL, PRIMARY KEY(sweep_id,item_id));
CREATE TABLE judgment_operations (
 operation_key TEXT PRIMARY KEY, sweep_id INTEGER NOT NULL REFERENCES sweeps(id), item_id INTEGER,
 command TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL,
 result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, error TEXT
);
CREATE TABLE external_attempts (id INTEGER PRIMARY KEY, operation_key TEXT NOT NULL REFERENCES judgment_operations(operation_key), status TEXT NOT NULL DEFAULT 'unknown', started_at TEXT NOT NULL, ended_at TEXT, response_json TEXT, cost_usd REAL, cost_source TEXT NOT NULL DEFAULT 'unknown');
CREATE TABLE sweep_budgets (sweep_id INTEGER PRIMARY KEY REFERENCES sweeps(id), jev_limit INTEGER NOT NULL DEFAULT 800, jev_reserved INTEGER NOT NULL DEFAULT 0);
CREATE TABLE lingering_executions (sweep_id INTEGER PRIMARY KEY REFERENCES sweeps(id), submission_id INTEGER, task_id INTEGER, reason TEXT NOT NULL, recorded_at TEXT NOT NULL, resolved_at TEXT);
