mod util;

use serde::{Deserialize, Serialize};
use serde_json::json;
use util::{
    constant_time_eq, epoch_to_iso, first_image_url, is_valid_slug, iso_to_epoch, make_excerpt,
    slug_from_published_at,
};
use worker::wasm_bindgen::JsValue;
use worker::*;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

// ---- JSON の型 ------------------------------------------------------------

/// 一覧用。本文は含めない。
#[derive(Debug, Serialize)]
struct PostSummary {
    id: i64,
    slug: String,
    title: String,
    excerpt: String,
    status: String,
    published_at: String,
    categories: Vec<String>,
    /// 本文の最初の画像。読み出しのたびに `content` から求める。
    thumbnail: Option<String>,
}

/// 一覧クエリの 1 行。サムネイルを求めるために `content` を読むが、応答には出さない。
#[derive(Deserialize)]
struct PostSummaryRow {
    id: i64,
    slug: String,
    title: String,
    content: String,
    excerpt: String,
    status: String,
    published_at: String,
}

impl From<PostSummaryRow> for PostSummary {
    fn from(row: PostSummaryRow) -> Self {
        PostSummary {
            thumbnail: first_image_url(&row.content),
            id: row.id,
            slug: row.slug,
            title: row.title,
            excerpt: row.excerpt,
            status: row.status,
            published_at: row.published_at,
            categories: Vec::new(),
        }
    }
}

/// 詳細用。
#[derive(Debug, Serialize, Deserialize)]
struct Post {
    id: i64,
    slug: String,
    title: String,
    content: String,
    excerpt: String,
    status: String,
    published_at: String,
    updated_at: String,
    legacy_url: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct PostInput {
    title: String,
    content: String,
    /// 作成時の既定は draft。更新時に省略すれば今の値のまま。
    status: Option<String>,
    published_at: Option<String>,
    slug: Option<String>,
    /// 作成時の既定は空。更新時に省略すれば今のカテゴリのまま（`[]` を渡すと全部外す）。
    categories: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CategoryRow {
    post_id: i64,
    name: String,
}

#[derive(Deserialize)]
struct Count {
    total: i64,
}

#[derive(Deserialize)]
struct IdRow {
    id: i64,
}

// ---- 小さな補助関数 ------------------------------------------------------

fn text(s: &str) -> JsValue {
    JsValue::from_str(s)
}

fn num(n: i64) -> JsValue {
    JsValue::from_f64(n as f64)
}

fn json_error(message: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({ "error": message })).map(|r| r.with_status(status))
}

fn is_admin(req: &Request, env: &Env) -> bool {
    let Ok(Some(header)) = req.headers().get("Authorization") else {
        return false;
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    match env.secret("ADMIN_TOKEN") {
        Ok(secret) => constant_time_eq(token, &secret.to_string()),
        Err(_) => false,
    }
}

/// クエリ文字列から値を取り出す。
fn query_param(req: &Request, key: &str) -> Result<Option<String>> {
    Ok(req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned()))
}

fn now_iso() -> String {
    epoch_to_iso((Date::now().as_millis() / 1000) as i64)
}

/// 投稿の入力を確認して、問題があればメッセージを返す。
fn validate_input(input: &PostInput) -> Option<&'static str> {
    if input.title.trim().is_empty() {
        return Some("title is required");
    }
    if let Some(status) = &input.status {
        if status != "draft" && status != "published" {
            return Some("status must be 'draft' or 'published'");
        }
    }
    if let Some(at) = &input.published_at {
        if iso_to_epoch(at).is_none() {
            return Some("published_at must be like 2019-11-22T18:13:44Z");
        }
    }
    if let Some(slug) = &input.slug {
        if !is_valid_slug(slug) {
            return Some("slug may only contain letters, digits, '-', '_' and '/'");
        }
    }
    if input
        .categories
        .iter()
        .flatten()
        .any(|c| c.trim().is_empty() || c.len() > 100)
    {
        return Some("category names must be 1-100 characters");
    }
    None
}

/// 記事に付けるカテゴリを書き込む SQL を作る。`post_ref` が id か slug かで条件を切り替える。
fn category_statements(
    d1: &D1Database,
    categories: &[String],
    by_id: bool,
    post_ref: JsValue,
) -> Result<Vec<D1PreparedStatement>> {
    let link_sql = if by_id {
        "INSERT OR IGNORE INTO post_categories (post_id, category_id) \
         SELECT p.id, c.id FROM posts p, categories c WHERE p.id = ? AND c.name = ?"
    } else {
        "INSERT OR IGNORE INTO post_categories (post_id, category_id) \
         SELECT p.id, c.id FROM posts p, categories c WHERE p.slug = ? AND c.name = ?"
    };
    let mut statements = Vec::new();
    for name in categories {
        let name = name.trim();
        statements.push(
            d1.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)")
                .bind(&[text(name)])?,
        );
        statements.push(d1.prepare(link_sql).bind(&[post_ref.clone(), text(name)])?);
    }
    Ok(statements)
}

/// 一覧の各記事にカテゴリ名を付ける（N+1 にならないよう 1 クエリでまとめて取る）。
async fn attach_categories(d1: &D1Database, posts: &mut [PostSummary]) -> Result<()> {
    if posts.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; posts.len()].join(",");
    let sql = format!(
        "SELECT pc.post_id AS post_id, c.name AS name FROM post_categories pc \
         JOIN categories c ON c.id = pc.category_id WHERE pc.post_id IN ({placeholders}) \
         ORDER BY c.name"
    );
    let ids: Vec<JsValue> = posts.iter().map(|p| num(p.id)).collect();
    let rows: Vec<CategoryRow> = d1.prepare(&sql).bind(&ids)?.all().await?.results()?;
    for row in rows {
        if let Some(post) = posts.iter_mut().find(|p| p.id == row.post_id) {
            post.categories.push(row.name);
        }
    }
    Ok(())
}

// ---- ハンドラ ------------------------------------------------------------

async fn list_posts(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let include_drafts = is_admin(&req, &ctx.env);
    let page = query_param(&req, "page")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1)
        .max(1);
    let limit = query_param(&req, "limit")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let category = query_param(&req, "category")?.unwrap_or_default();

    let filter = "(? = 1 OR p.status = 'published') AND (? = '' OR p.id IN \
                  (SELECT pc.post_id FROM post_categories pc \
                   JOIN categories c ON c.id = pc.category_id WHERE c.name = ?))";
    let draft_flag = num(include_drafts as i64);
    let d1 = ctx.env.d1("DB")?;

    let total: Option<Count> = d1
        .prepare(format!(
            "SELECT COUNT(*) AS total FROM posts p WHERE {filter}"
        ))
        .bind(&[draft_flag.clone(), text(&category), text(&category)])?
        .first(None)
        .await?;

    let rows: Vec<PostSummaryRow> = d1
        .prepare(format!(
            "SELECT p.id, p.slug, p.title, p.content, p.excerpt, p.status, p.published_at \
             FROM posts p \
             WHERE {filter} ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?"
        ))
        .bind(&[
            draft_flag,
            text(&category),
            text(&category),
            num(limit),
            num((page - 1) * limit),
        ])?
        .all()
        .await?
        .results()?;
    let mut posts: Vec<PostSummary> = rows.into_iter().map(PostSummary::from).collect();
    attach_categories(&d1, &mut posts).await?;

    Response::from_json(&json!({
        "posts": posts,
        "page": page,
        "limit": limit,
        "total": total.map(|c| c.total).unwrap_or(0),
    }))
}

async fn fetch_post(
    d1: &D1Database,
    where_sql: &str,
    key: JsValue,
    include_drafts: bool,
) -> Result<Option<Post>> {
    let post: Option<Post> = d1
        .prepare(format!(
            "SELECT id, slug, title, content, excerpt, status, published_at, updated_at, legacy_url \
             FROM posts WHERE {where_sql} AND (? = 1 OR status = 'published')"
        ))
        .bind(&[key, num(include_drafts as i64)])?
        .first(None)
        .await?;
    let Some(mut post) = post else {
        return Ok(None);
    };
    let rows: Vec<CategoryRow> = d1
        .prepare(
            "SELECT pc.post_id AS post_id, c.name AS name FROM post_categories pc \
             JOIN categories c ON c.id = pc.category_id WHERE pc.post_id = ? ORDER BY c.name",
        )
        .bind(&[num(post.id)])?
        .all()
        .await?
        .results()?;
    post.categories = rows.into_iter().map(|r| r.name).collect();
    Ok(Some(post))
}

async fn get_post_by_slug(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let Some(slug) = ctx.param("slug") else {
        return json_error("slug is required", 400);
    };
    let d1 = ctx.env.d1("DB")?;
    match fetch_post(&d1, "slug = ?", text(slug), is_admin(&req, &ctx.env)).await? {
        Some(post) => Response::from_json(&post),
        None => json_error("Not Found", 404),
    }
}

async fn get_post_by_id(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let d1 = ctx.env.d1("DB")?;
    match fetch_post(&d1, "id = ?", num(id), true).await? {
        Some(post) => Response::from_json(&post),
        None => json_error("Not Found", 404),
    }
}

async fn list_categories(_req: Request, ctx: RouteContext<()>) -> Result<Response> {
    #[derive(Serialize, Deserialize)]
    struct CategoryCount {
        name: String,
        count: i64,
    }
    let d1 = ctx.env.d1("DB")?;
    let categories: Vec<CategoryCount> = d1
        .prepare(
            "SELECT c.name AS name, COUNT(p.id) AS count FROM categories c \
             JOIN post_categories pc ON pc.category_id = c.id \
             JOIN posts p ON p.id = pc.post_id AND p.status = 'published' \
             GROUP BY c.id ORDER BY count DESC, c.name",
        )
        .all()
        .await?
        .results()?;
    Response::from_json(&json!({ "categories": categories }))
}

async fn create_post(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let input: PostInput = match req.json().await {
        Ok(v) => v,
        Err(_) => return json_error("Invalid JSON body", 400),
    };
    if let Some(message) = validate_input(&input) {
        return json_error(message, 400);
    }

    let published_at = input.published_at.clone().unwrap_or_else(now_iso);
    let slug = match &input.slug {
        Some(s) => s.clone(),
        None => match slug_from_published_at(&published_at) {
            Some(s) => s,
            None => return json_error("could not build a slug", 400),
        },
    };

    let d1 = ctx.env.d1("DB")?;
    let exists: Option<IdRow> = d1
        .prepare("SELECT id FROM posts WHERE slug = ?")
        .bind(&[text(&slug)])?
        .first(None)
        .await?;
    if exists.is_some() {
        return json_error("slug already exists", 409);
    }

    let mut statements = vec![d1
        .prepare(
            "INSERT INTO posts (slug, title, content, excerpt, status, published_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&[
            text(&slug),
            text(input.title.trim()),
            text(&input.content),
            text(&make_excerpt(&input.content, 120)),
            text(input.status.as_deref().unwrap_or("draft")),
            text(&published_at),
        ])?];
    statements.extend(category_statements(
        &d1,
        input.categories.as_deref().unwrap_or_default(),
        false,
        text(&slug),
    )?);
    d1.batch(statements).await?;

    let created: Option<IdRow> = d1
        .prepare("SELECT id FROM posts WHERE slug = ?")
        .bind(&[text(&slug)])?
        .first(None)
        .await?;
    let id = created.map(|r| r.id).unwrap_or(0);
    Response::from_json(&json!({ "id": id, "slug": slug })).map(|r| r.with_status(201))
}

async fn update_post(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let input: PostInput = match req.json().await {
        Ok(v) => v,
        Err(_) => return json_error("Invalid JSON body", 400),
    };
    if let Some(message) = validate_input(&input) {
        return json_error(message, 400);
    }

    let d1 = ctx.env.d1("DB")?;
    let Some(current) = fetch_post(&d1, "id = ?", num(id), true).await? else {
        return json_error("Not Found", 404);
    };
    // 省略された項目（slug、published_at、status、categories）は今の値のままにする
    let slug = input.slug.clone().unwrap_or(current.slug.clone());
    let published_at = input
        .published_at
        .clone()
        .unwrap_or(current.published_at.clone());
    if slug != current.slug {
        let taken: Option<IdRow> = d1
            .prepare("SELECT id FROM posts WHERE slug = ?")
            .bind(&[text(&slug)])?
            .first(None)
            .await?;
        if taken.is_some() {
            return json_error("slug already exists", 409);
        }
    }

    let status = input.status.as_deref().unwrap_or(&current.status);
    let mut statements = vec![d1
        .prepare(
            "UPDATE posts SET slug = ?, title = ?, content = ?, excerpt = ?, status = ?, \
             published_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
        )
        .bind(&[
            text(&slug),
            text(input.title.trim()),
            text(&input.content),
            text(&make_excerpt(&input.content, 120)),
            text(status),
            text(&published_at),
            num(id),
        ])?];
    // categories を省略したときは今のカテゴリを触らない
    if let Some(categories) = &input.categories {
        statements.push(
            d1.prepare("DELETE FROM post_categories WHERE post_id = ?")
                .bind(&[num(id)])?,
        );
        statements.extend(category_statements(&d1, categories, true, num(id))?);
    }
    d1.batch(statements).await?;

    Response::from_json(&json!({ "id": id, "slug": slug }))
}

async fn delete_post(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let d1 = ctx.env.d1("DB")?;
    let exists: Option<IdRow> = d1
        .prepare("SELECT id FROM posts WHERE id = ?")
        .bind(&[num(id)])?
        .first(None)
        .await?;
    if exists.is_none() {
        return json_error("Not Found", 404);
    }
    d1.batch(vec![
        d1.prepare("DELETE FROM post_categories WHERE post_id = ?")
            .bind(&[num(id)])?,
        d1.prepare("DELETE FROM posts WHERE id = ?")
            .bind(&[num(id)])?,
    ])
    .await?;
    Ok(Response::empty()?.with_status(204))
}

// ---- エントリポイント --------------------------------------------------

/// どの応答にも（エラーでも）CORS ヘッダを付ける。
fn with_cors(mut response: Response, env: &Env) -> Result<Response> {
    let origin = env
        .var("CORS_ALLOW_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "*".to_string());
    let headers = response.headers_mut();
    headers.set("Access-Control-Allow-Origin", &origin)?;
    headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    )?;
    headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    headers.set("Vary", "Origin")?;
    Ok(response)
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let router = Router::new();
    let result = router
        .options("/*catchall", |_req, _ctx| {
            Ok(Response::empty()?.with_status(204))
        })
        .get_async("/api/posts", list_posts)
        .get_async("/api/posts/by-slug/*slug", get_post_by_slug)
        .get_async("/api/posts/:id", get_post_by_id)
        .get_async("/api/categories", list_categories)
        .post_async("/api/posts", create_post)
        .put_async("/api/posts/:id", update_post)
        .delete_async("/api/posts/:id", delete_post)
        .run(req, env.clone())
        .await;

    let response = match result {
        Ok(r) => r,
        Err(e) => {
            console_error!("unhandled error: {e}");
            json_error("Internal Server Error", 500)?
        }
    };
    with_cors(response, &env)
}
