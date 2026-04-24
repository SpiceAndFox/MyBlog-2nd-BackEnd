CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE diaries (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    summary VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    author_id INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

CREATE INDEX idx_diaries_author_id ON diaries(author_id);
CREATE INDEX idx_diaries_status_published_at ON diaries(status, published_at);
CREATE INDEX idx_diaries_author_status_published_at ON diaries(author_id, status, published_at);

CREATE TRIGGER update_diaries_updated_at
BEFORE UPDATE ON diaries
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
