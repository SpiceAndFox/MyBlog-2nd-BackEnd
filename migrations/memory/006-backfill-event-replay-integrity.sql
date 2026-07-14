BEGIN;

UPDATE chat_memory_events
SET item_id = normalized_operation->>'itemId'
WHERE decision = 'system_cleanup'
  AND cleanup_type IN ('todo_became_overdue', 'todo_revived_from_overdue', 'recent_episode_evicted')
  AND item_id IS NULL
  AND normalized_operation ? 'itemId';

UPDATE chat_memory_events
SET normalized_operation = jsonb_set(
  normalized_operation,
  '{evidenceRefs}',
  normalized_operation #> '{value,evidenceGroups,0,refs}',
  TRUE
)
WHERE decision = 'accepted'
  AND op = 'addItem'
  AND jsonb_typeof(normalized_operation #> '{value,evidenceGroups,0,refs}') = 'array'
  AND normalized_operation->'evidenceRefs'
      IS DISTINCT FROM normalized_operation #> '{value,evidenceGroups,0,refs}';

COMMIT;
