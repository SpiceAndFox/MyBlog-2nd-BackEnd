BEGIN;

-- Memory 2.01 does not backfill or replay legacy derived events. The cutover
-- data migration purges derived history and rebuilds it from raw messages.

COMMIT;
