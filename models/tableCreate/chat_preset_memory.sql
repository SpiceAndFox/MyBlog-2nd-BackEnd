CREATE TABLE IF NOT EXISTS chat_preset_memory (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    memory_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, preset_id),
    CONSTRAINT fk_chat_preset_memory_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_preset_memory_user_preset ON chat_preset_memory(user_id, preset_id);
CREATE INDEX IF NOT EXISTS idx_chat_preset_memory_user_updated_at ON chat_preset_memory(user_id, updated_at DESC);
