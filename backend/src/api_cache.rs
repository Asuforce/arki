use serde::Deserialize;
use worker::*;

/// 外部（ブラウザ・ゾーンキャッシュ）向けの Cache-Control。
/// ゾーンキャッシュと Tiered Cache で POP 間の巡回を吸収しつつ、最大 5 分で最新化する。
pub(crate) const PUBLIC_CACHE_CONTROL: &str =
    "public, max-age=60, s-maxage=300, stale-while-revalidate=300";

/// Worker 内部の Cache API に載せる Cache-Control。
/// バージョン付きキーで無効化できるため、長めに保持する。
pub(crate) const INTERNAL_CACHE_CONTROL: &str = "public, max-age=86400";

const VERSION_KEY: &str = "api_cache_version";

#[derive(Deserialize)]
struct ValueRow {
    value: String,
}

/// 公開 GET かつ認証なし、かつキャッシュ対象のルートか判定する。
pub(crate) fn is_cacheable_route(method: &Method, path: &str, authenticated: bool) -> bool {
    if authenticated || *method != Method::Get {
        return false;
    }
    matches!(
        path,
        "/api/posts" | "/api/categories" | "/api/archive" | "/api/sitemap"
    ) || path.starts_with("/api/posts/by-slug/")
}

/// バージョン番号と URL（パス＋クエリ）から内部 Cache API 用のキーを作る。
pub(crate) fn cache_key(version: &str, url: &Url) -> String {
    let path_and_query = match url.query() {
        Some(q) if !q.is_empty() => format!("{}?{q}", url.path()),
        _ => url.path().to_string(),
    };
    format!("https://arki-cache.internal/v{version}{path_and_query}")
}

/// D1 から現在のキャッシュバージョンを読む。未初期化でも `"1"` にフォールバックする。
pub(crate) async fn read_version(d1: &D1Database) -> String {
    let row: Result<Option<ValueRow>> = d1
        .prepare("SELECT value FROM cache_meta WHERE key = ?")
        .bind(&[VERSION_KEY.into()])
        .unwrap()
        .first(None)
        .await;
    match row {
        Ok(Some(r)) => r.value,
        Ok(None) => "1".to_string(),
        Err(e) => {
            console_error!("cache_meta read failed: {e}");
            "1".to_string()
        }
    }
}

/// 投稿の作成・更新・削除時にバージョンを上げ、古いキャッシュを一括無効化する。
/// 失敗時は `console_error!` に加え、応答ヘッダー `X-Api-Cache-Bump: failed` で運用側へ知らせる。
pub(crate) async fn bump_version(d1: &D1Database, response: &mut Response) {
    let stmt = match d1
        .prepare(
            "INSERT INTO cache_meta (key, value) VALUES (?, '2') \
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        )
        .bind(&[VERSION_KEY.into()])
    {
        Ok(s) => s,
        Err(e) => {
            console_error!("cache_meta prepare failed: {e}");
            let _ = response.headers_mut().set("X-Api-Cache-Bump", "failed");
            return;
        }
    };
    if let Err(e) = stmt.run().await {
        console_error!("cache_meta bump failed: {e}");
        let _ = response.headers_mut().set("X-Api-Cache-Bump", "failed");
    }
}

/// Cache API から取得した応答を、外向きヘッダー付きの新しい Response に詰め替える。
pub(crate) async fn hit_response(mut cached: Response) -> Result<Response> {
    let bytes = cached.bytes().await?;
    let mut response = Response::from_bytes(bytes)?;
    let headers = response.headers_mut();
    headers.set("Content-Type", "application/json")?;
    headers.set("Cache-Control", PUBLIC_CACHE_CONTROL)?;
    headers.set("X-Api-Cache", "HIT")?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cacheable_only_for_unauthenticated_public_gets() {
        assert!(is_cacheable_route(&Method::Get, "/api/posts", false));
        assert!(is_cacheable_route(&Method::Get, "/api/categories", false));
        assert!(is_cacheable_route(&Method::Get, "/api/archive", false));
        assert!(is_cacheable_route(&Method::Get, "/api/sitemap", false));
        assert!(is_cacheable_route(
            &Method::Get,
            "/api/posts/by-slug/2026/01/01/000000",
            false
        ));

        // 認証付きは不可
        assert!(!is_cacheable_route(&Method::Get, "/api/posts", true));
        assert!(!is_cacheable_route(&Method::Get, "/api/categories", true));

        // 書き込みや管理用ルートは不可
        assert!(!is_cacheable_route(&Method::Post, "/api/posts", false));
        assert!(!is_cacheable_route(&Method::Get, "/api/posts/1", false));
    }

    #[test]
    fn cache_key_includes_version_path_and_query() {
        let u1 = Url::parse("https://api.example.com/api/posts?page=2&category=rust").unwrap();
        let u2 = Url::parse("https://api.example.com/api/categories").unwrap();
        assert_eq!(
            cache_key("3", &u1),
            "https://arki-cache.internal/v3/api/posts?page=2&category=rust"
        );
        assert_eq!(
            cache_key("3", &u2),
            "https://arki-cache.internal/v3/api/categories"
        );
    }
}
