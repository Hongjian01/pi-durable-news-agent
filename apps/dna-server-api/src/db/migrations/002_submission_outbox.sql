-- Additive migration: existing sweeps remain readable. Old queued rows without
-- a frozen payload cannot safely be reconstructed from current preferences.
CREATE TABLE evaluation_contexts (
  id INTEGER PRIMARY KEY,
  context_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER evaluation_contexts_immutable
BEFORE UPDATE ON evaluation_contexts BEGIN
  SELECT RAISE(ABORT, 'evaluation context is immutable');
END;

ALTER TABLE sweeps ADD COLUMN context_id INTEGER REFERENCES evaluation_contexts(id);
ALTER TABLE sweeps ADD COLUMN execution_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE submission_outbox (
  sweep_id INTEGER PRIMARY KEY REFERENCES sweeps(id),
  request_id TEXT NOT NULL UNIQUE,
  context_id INTEGER NOT NULL REFERENCES evaluation_contexts(id),
  execution_epoch INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitting', 'linked', 'failed')),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  submission_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'submitting') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status = 'linked') = (submission_id IS NOT NULL))
);
CREATE INDEX submission_outbox_pending ON submission_outbox(status, lease_until);
