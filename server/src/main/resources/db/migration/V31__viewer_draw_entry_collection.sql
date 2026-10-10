CREATE TABLE viewer_draw_entry_collection (
  collection_id INTEGER PRIMARY KEY CHECK(collection_id = 1),
  source TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('IDLE', 'OPEN', 'PAUSED', 'CLOSED')),
  accepted_messages INTEGER NOT NULL DEFAULT 0,
  duplicate_messages INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT
);

CREATE TABLE viewer_draw_entry_collection_member (
  entry_key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  label TEXT NOT NULL
);

INSERT INTO viewer_draw_entry_collection(
  collection_id, source, provider, channel_id, keyword, state
) VALUES (1, 'MANUAL_LIST', '', '', '', 'IDLE');
