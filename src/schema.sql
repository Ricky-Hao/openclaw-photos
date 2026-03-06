CREATE TABLE IF NOT EXISTS collections (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS photos (
  id          TEXT PRIMARY KEY,
  collection  TEXT NOT NULL REFERENCES collections(id),
  file        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  hash        TEXT,
  added_at    TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (photo_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_photos_collection ON photos(collection);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(hash);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON photo_tags(tag);
