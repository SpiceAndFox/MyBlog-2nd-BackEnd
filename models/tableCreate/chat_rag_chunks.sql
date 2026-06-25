# cd BlogBackEnd && pnpm regenerate-chat-rag -- --user spice --preset Lina-Weil --clear  # 回填某个角色的历史
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chat_rag_chunks (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    first_message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    last_message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    source_kind VARCHAR(32) NOT NULL,
    source_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding vector NOT NULL,
    embedding_provider VARCHAR(64) NOT NULL,
    embedding_model VARCHAR(255) NOT NULL,
    embedding_dimensions INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_chat_rag_chunks_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT chk_chat_rag_chunks_chunk_index_non_negative CHECK (chunk_index >= 0),
    CONSTRAINT chk_chat_rag_chunks_embedding_dimensions_positive CHECK (embedding_dimensions > 0),
    CONSTRAINT chk_chat_rag_chunks_message_range CHECK (first_message_id <= last_message_id),
    UNIQUE (user_id, preset_id, session_id, first_message_id, last_message_id, chunk_index)
);

CREATE INDEX idx_chat_rag_chunks_scope
    ON chat_rag_chunks(user_id, preset_id, last_message_id DESC);

CREATE INDEX idx_chat_rag_chunks_session
    ON chat_rag_chunks(session_id, last_message_id DESC);

CREATE TRIGGER update_chat_rag_chunks_updated_at
BEFORE UPDATE ON chat_rag_chunks
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

