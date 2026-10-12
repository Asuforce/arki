-- 1: 変えてはいけない。公開したことがある、はてなから取り込んだ、または手で決めた記事。
-- 0 の下書きは、初回公開のときに slug を公開日時から作り直し、日付には公開の瞬間を入れる。
ALTER TABLE posts ADD COLUMN slug_fixed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN date_fixed INTEGER NOT NULL DEFAULT 0;

UPDATE posts SET slug_fixed = 1, date_fixed = 1 WHERE status = 'published' OR legacy_url IS NOT NULL;
