-- Backfill published_at for published articles that lost their publish timestamp.
-- This uses created_at as the safest available fallback.
UPDATE articles
SET published_at = created_at
WHERE status = 'published'
  AND published_at IS NULL;
