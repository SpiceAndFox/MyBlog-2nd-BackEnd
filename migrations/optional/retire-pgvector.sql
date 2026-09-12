-- Run as the extension owner after 015-retire-chat-rag.sql.
-- RESTRICT refuses deletion if another application still uses vector types.
DROP EXTENSION IF EXISTS vector RESTRICT;
