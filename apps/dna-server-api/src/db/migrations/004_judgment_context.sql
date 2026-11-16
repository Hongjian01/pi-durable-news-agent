-- Additive: historical rows remain readable and cannot become precise cache hits.
ALTER TABLE classifications ADD COLUMN context_state TEXT NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE story_decisions ADD COLUMN context_state TEXT NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE judgment_operations ADD COLUMN context_state TEXT NOT NULL DEFAULT 'legacy_unversioned';
ALTER TABLE judgment_operations ADD COLUMN context_id INTEGER REFERENCES evaluation_contexts(id);
ALTER TABLE judgment_operations ADD COLUMN input_hash TEXT;
ALTER TABLE judgment_operations ADD COLUMN cache_key TEXT;
ALTER TABLE judgment_operations ADD COLUMN command_version INTEGER;
ALTER TABLE judgment_operations ADD COLUMN command_hash TEXT;
ALTER TABLE judgment_operations ADD COLUMN decision_json TEXT;
ALTER TABLE judgment_operations ADD COLUMN raw_attempt_id INTEGER REFERENCES external_attempts(id);
ALTER TABLE judgment_operations ADD COLUMN cache_source_operation TEXT REFERENCES judgment_operations(operation_key);
ALTER TABLE judgment_operations ADD COLUMN requested_model TEXT;
ALTER TABLE judgment_operations ADD COLUMN resolved_model TEXT;
CREATE TABLE judgment_cache (
 cache_key TEXT PRIMARY KEY,
 operation_key TEXT NOT NULL REFERENCES judgment_operations(operation_key),
 result_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER judgment_cache_immutable BEFORE UPDATE ON judgment_cache
BEGIN SELECT RAISE(ABORT,'judgment cache is immutable'); END;
