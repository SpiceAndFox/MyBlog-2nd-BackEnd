CREATE TABLE tags (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    parent_id INTEGER REFERENCES tags(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tags_parent_id ON tags(parent_id);
CREATE UNIQUE INDEX idx_tags_top_level_name_unique ON tags (LOWER(name)) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX idx_tags_child_parent_name_unique ON tags (parent_id, LOWER(name)) WHERE parent_id IS NOT NULL;
