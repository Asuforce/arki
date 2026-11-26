-- 公開 API キャッシュの一括無効化に使うバージョン番号。
CREATE TABLE IF NOT EXISTS cache_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO cache_meta (key, value) VALUES ('api_cache_version', '1');
