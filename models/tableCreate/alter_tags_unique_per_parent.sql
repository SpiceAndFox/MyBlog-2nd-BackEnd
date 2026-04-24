ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_top_level_name_unique
ON tags (LOWER(name))
WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_child_parent_name_unique
ON tags (parent_id, LOWER(name))
WHERE parent_id IS NOT NULL;
