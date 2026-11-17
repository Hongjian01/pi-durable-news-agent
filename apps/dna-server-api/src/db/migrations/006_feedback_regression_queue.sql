-- Persist negative feedback intake at the point of user feedback, including
-- across restarts. Store references, not another copy of private user notes.
CREATE TABLE feedback_regression_queue (
  feedback_id INTEGER PRIMARY KEY REFERENCES feedback(id),
  status TEXT NOT NULL DEFAULT 'awaiting_review',
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO feedback_regression_queue(feedback_id,created_at)
SELECT id,created_at FROM feedback WHERE signal='less' OR length(note)>0;
CREATE TRIGGER feedback_regression_enqueue AFTER INSERT ON feedback
WHEN NEW.signal='less' OR length(NEW.note)>0
BEGIN
  INSERT OR IGNORE INTO feedback_regression_queue(feedback_id,created_at)
  VALUES(NEW.id,NEW.created_at);
END;
