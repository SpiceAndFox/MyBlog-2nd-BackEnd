CREATE TABLE chat_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    turn_id UUID,
    parent_user_message_id BIGINT REFERENCES chat_messages(id) ON DELETE CASCADE,
    idempotency_key TEXT,
    source_generation BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_chat_messages_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX idx_chat_messages_session_created_at ON chat_messages(session_id, created_at);
CREATE INDEX idx_chat_messages_turn_id ON chat_messages(turn_id);
CREATE UNIQUE INDEX idx_chat_messages_scope_idempotency
    ON chat_messages(user_id, preset_id, idempotency_key)
    WHERE role = 'user' AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_chat_messages_one_assistant_per_parent
    ON chat_messages(parent_user_message_id)
    WHERE role = 'assistant' AND parent_user_message_id IS NOT NULL;
