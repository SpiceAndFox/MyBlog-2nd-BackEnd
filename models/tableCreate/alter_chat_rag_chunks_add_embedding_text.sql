-- Adds a dedicated embedding-text column so vector embeddings are built from
-- clean user-only text, separate from the parseable display `content`.
-- Apply manually via psql/pgAdmin (no migration runner in this project).
ALTER TABLE chat_rag_chunks
  ADD COLUMN IF NOT EXISTS embedding_text TEXT NOT NULL DEFAULT '';

-- Backfill: existing rows get embedding_text = content (valid until full rebuild
-- re-embeds them with clean user-only text via pnpm regenerate-chat-rag -- --clear).
UPDATE chat_rag_chunks SET embedding_text = content WHERE embedding_text = '';