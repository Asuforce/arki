-- 1: slug を変えてはいけない（公開したことがある、取り込み済み、または明示した）。
-- 0 の下書きは、初回公開のときに公開日時から slug を作り直す。
ALTER TABLE posts ADD COLUMN slug_fixed INTEGER NOT NULL DEFAULT 0;

UPDATE posts SET slug_fixed = 1 WHERE status = 'published' OR legacy_url IS NOT NULL;
