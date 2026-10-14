mod clef;
mod images;
mod tier;
mod util;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tier::{Classification, Gate, TierConfig, TierInput, TierState, TierWrite};
use util::{
    constant_time_eq, epoch_to_iso, first_image_url, is_valid_slug, iso_to_epoch, like_pattern,
    make_excerpt, slug_from_published_at,
};
use worker::wasm_bindgen::JsValue;
use worker::*;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;
const MAX_SLUG_SUFFIX: i64 = 20;
/// 公開の記事応答には出さない、編集のための状態。
const ADMIN_ONLY_FIELDS: &[&str] = &["created_at", "slug_fixed", "date_unset"];

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
    /// 管理者の応答にだけ出す。
    #[serde(flatten)]
    tier_state: Option<TierState>,
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
    tier: Option<i64>,
    tier_confidence: Option<f64>,
    tier_locked: i64,
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
            tier_state: None,
        }
    }
}

impl PostSummary {
    fn with_tier(mut self, state: TierState) -> Self {
        self.tier_state = Some(state);
        self
    }
}

/// 管理者のときだけ tier を詰める。公開の応答には tier の型の値が入らない。
fn summary_for(row: PostSummaryRow, admin: bool) -> PostSummary {
    let state = TierState::from_columns(row.tier, row.tier_confidence, row.tier_locked);
    let summary = PostSummary::from(row);
    if admin {
        summary.with_tier(state)
    } else {
        summary
    }
}

/// 詳細用。
#[derive(Debug, Serialize)]
struct Post {
    id: i64,
    slug: String,
    title: String,
    content: String,
    excerpt: String,
    status: String,
    published_at: String,
    created_at: String,
    updated_at: String,
    legacy_url: Option<String>,
    /// true なら slug は変わらない。false の下書きは初回公開で作り直される。
    slug_fixed: bool,
    /// true なら公開日時は決まっておらず、初回公開の瞬間が入る（`published_at` は仮の値）。
    date_unset: bool,
    categories: Vec<String>,
    /// 管理者の応答にだけ出す。
    #[serde(flatten)]
    tier_state: Option<TierState>,
}

#[derive(Deserialize)]
struct PostRow {
    id: i64,
    slug: String,
    title: String,
    content: String,
    excerpt: String,
    status: String,
    published_at: String,
    created_at: String,
    updated_at: String,
    legacy_url: Option<String>,
    slug_fixed: i64,
    date_fixed: i64,
    tier: Option<i64>,
    tier_confidence: Option<f64>,
    tier_locked: i64,
}

impl From<PostRow> for Post {
    fn from(row: PostRow) -> Self {
        Post {
            slug_fixed: row.slug_fixed != 0,
            date_unset: row.date_fixed == 0,
            id: row.id,
            slug: row.slug,
            title: row.title,
            content: row.content,
            excerpt: row.excerpt,
            status: row.status,
            published_at: row.published_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
            legacy_url: row.legacy_url,
            categories: Vec::new(),
            tier_state: None,
        }
    }
}

impl Post {
    fn with_tier(mut self, state: TierState) -> Self {
        self.tier_state = Some(state);
        self
    }
}

fn post_for(row: PostRow, admin: bool) -> Post {
    let state = TierState::from_columns(row.tier, row.tier_confidence, row.tier_locked);
    let post = Post::from(row);
    if admin {
        post.with_tier(state)
    } else {
        post
    }
}

/// 記事の応答の JSON。公開では、編集のための項目と tier を含めない。
fn post_json(post: &Post, admin: bool) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(post)?;
    if let Some(object) = value.as_object_mut().filter(|_| !admin) {
        for key in ADMIN_ONLY_FIELDS {
            object.remove(*key);
        }
    }
    Ok(value)
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
    /// 更新時だけ。今の `updated_at` と違えば、何も書かずに 409 を返す。
    expected_updated_at: Option<String>,
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

pub(crate) fn json_error(message: &str, status: u16) -> Result<Response> {
    Response::from_json(&json!({ "error": message })).map(|r| r.with_status(status))
}

pub(crate) fn is_admin(req: &Request, env: &Env) -> bool {
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
/// `expected_updated_at` が空でなければ、記事がその時刻のままのときだけ書く（id のときのみ）。
fn category_statements(
    d1: &D1Database,
    categories: &[String],
    by_id: bool,
    post_ref: JsValue,
    expected_updated_at: &str,
) -> Result<Vec<D1PreparedStatement>> {
    let link_sql = if by_id {
        "INSERT OR IGNORE INTO post_categories (post_id, category_id) \
         SELECT p.id, c.id FROM posts p, categories c WHERE p.id = ? AND c.name = ? \
         AND (? = '' OR p.updated_at = ?)"
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
        let mut binds = vec![post_ref.clone(), text(name)];
        if by_id {
            binds.extend([text(expected_updated_at), text(expected_updated_at)]);
        }
        statements.push(d1.prepare(link_sql).bind(&binds)?);
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

/// 一覧の `status` の指定。下書きが見えるのは管理者だけなので、管理者以外は無視する。
fn status_filter(req: &Request, is_admin: bool) -> Result<String> {
    let status = query_param(req, "status")?.unwrap_or_default();
    Ok(
        if is_admin && (status == "draft" || status == "published") {
            status
        } else {
            String::new()
        },
    )
}

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
    let status = status_filter(&req, include_drafts)?;
    let title_query = if include_drafts {
        query_param(&req, "q")?
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let title_pattern = if title_query.is_empty() {
        String::new()
    } else {
        like_pattern(&title_query)
    };

    let filter = "(? = 1 OR p.status = 'published') AND (? = '' OR p.status = ?) \
                  AND (? = '' OR p.title LIKE ? ESCAPE '\\') AND (? = '' OR p.id IN \
                  (SELECT pc.post_id FROM post_categories pc \
                   JOIN categories c ON c.id = pc.category_id WHERE c.name = ?))";
    let filter_binds = vec![
        num(include_drafts as i64),
        text(&status),
        text(&status),
        text(&title_pattern),
        text(&title_pattern),
        text(&category),
        text(&category),
    ];
    let d1 = ctx.env.d1("DB")?;

    let total: Option<Count> = d1
        .prepare(format!(
            "SELECT COUNT(*) AS total FROM posts p WHERE {filter}"
        ))
        .bind(&filter_binds)?
        .first(None)
        .await?;

    // 管理者には下書きを先頭に出す。バインドの順番は SQL の `?` の順（絞り込み、並び順、ページ）
    let mut binds = filter_binds;
    binds.extend([
        num(include_drafts as i64),
        num(limit),
        num((page - 1) * limit),
    ]);
    let rows: Vec<PostSummaryRow> = d1
        .prepare(format!(
            "SELECT p.id, p.slug, p.title, p.content, p.excerpt, p.status, p.published_at, \
             p.tier, p.tier_confidence, p.tier_locked \
             FROM posts p WHERE {filter} \
             ORDER BY CASE WHEN ? = 1 AND p.status = 'draft' THEN 0 ELSE 1 END, \
             p.published_at DESC, p.id DESC LIMIT ? OFFSET ?"
        ))
        .bind(&binds)?
        .all()
        .await?
        .results()?;
    let mut posts: Vec<PostSummary> = rows
        .into_iter()
        .map(|row| summary_for(row, include_drafts))
        .collect();
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
    admin: bool,
) -> Result<Option<Post>> {
    let row: Option<PostRow> = d1
        .prepare(format!(
            "SELECT id, slug, title, content, excerpt, status, published_at, created_at, \
             updated_at, legacy_url, slug_fixed, date_fixed, tier, tier_confidence, tier_locked \
             FROM posts WHERE {where_sql} AND (? = 1 OR status = 'published')"
        ))
        .bind(&[key, num(admin as i64)])?
        .first(None)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut post = post_for(row, admin);
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
    let admin = is_admin(&req, &ctx.env);
    match fetch_post(&d1, "slug = ?", text(slug), admin).await? {
        Some(post) => Response::from_json(&post_json(&post, admin)?),
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

async fn list_categories(req: Request, ctx: RouteContext<()>) -> Result<Response> {
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
             JOIN posts p ON p.id = pc.post_id AND (? = 1 OR p.status = 'published') \
             GROUP BY c.id ORDER BY count DESC, c.name",
        )
        .bind(&[num(is_admin(&req, &ctx.env) as i64)])?
        .all()
        .await?
        .results()?;
    Response::from_json(&json!({ "categories": categories }))
}

/// `base` が空いていればそれを、使われていれば `base_1`、`base_2` … を返す。`exclude_id` の記事自身は衝突とみなさない。
async fn unique_slug(
    d1: &D1Database,
    base: &str,
    exclude_id: Option<i64>,
) -> Result<Option<String>> {
    for n in 0..=MAX_SLUG_SUFFIX {
        let candidate = if n == 0 {
            base.to_string()
        } else {
            format!("{base}_{n}")
        };
        let taken: Option<IdRow> = d1
            .prepare("SELECT id FROM posts WHERE slug = ? AND id != ?")
            .bind(&[text(&candidate), num(exclude_id.unwrap_or(-1))])?
            .first(None)
            .await?;
        if taken.is_none() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn update_conflict(current: Option<String>) -> Result<Response> {
    Response::from_json(&json!({
        "error": "post was updated elsewhere",
        "updated_at": current,
    }))
    .map(|r| r.with_status(409))
}

/// UNIQUE 制約に負けたら、重複確認と書き込みの間に他の保存が割り込んだということ。
fn slug_race_or(error: Error) -> Result<Response> {
    if error.to_string().contains("UNIQUE") {
        json_error("slug already exists", 409)
    } else {
        Err(error)
    }
}

/// 更新後の `updated_at`。秒単位なので、同じ秒に続けて保存しても前より後ろに進める。
fn next_updated_at(now: &str, previous: &str) -> String {
    if now > previous {
        return now.to_string();
    }
    iso_to_epoch(previous)
        .map(|secs| epoch_to_iso(secs + 1))
        .unwrap_or_else(|| now.to_string())
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

    let now = now_iso();
    let published_at = input.published_at.clone().unwrap_or_else(|| now.clone());
    let status = input.status.as_deref().unwrap_or("draft");
    let d1 = ctx.env.d1("DB")?;
    let slug = match &input.slug {
        Some(s) => {
            let exists: Option<IdRow> = d1
                .prepare("SELECT id FROM posts WHERE slug = ?")
                .bind(&[text(s)])?
                .first(None)
                .await?;
            if exists.is_some() {
                return json_error("slug already exists", 409);
            }
            s.clone()
        }
        None => {
            let Some(base) = slug_from_published_at(&published_at) else {
                return json_error("could not build a slug", 400);
            };
            match unique_slug(&d1, &base, None).await? {
                Some(s) => s,
                None => return json_error("could not build a unique slug", 409),
            }
        }
    };
    // 下書きの slug と日付は仮のもの。公開済みで作るか、指定したときだけ固定する
    let slug_fixed = input.slug.is_some() || status == "published";
    let date_fixed = input.published_at.is_some() || status == "published";

    let mut statements = vec![d1
        .prepare(
            "INSERT INTO posts (slug, title, content, excerpt, status, published_at, \
             created_at, updated_at, slug_fixed, date_fixed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&[
            text(&slug),
            text(input.title.trim()),
            text(&input.content),
            text(&make_excerpt(&input.content, 120)),
            text(status),
            text(&published_at),
            text(&now),
            text(&now),
            num(slug_fixed as i64),
            num(date_fixed as i64),
        ])?];
    statements.extend(category_statements(
        &d1,
        input.categories.as_deref().unwrap_or_default(),
        false,
        text(&slug),
        "",
    )?);
    if let Err(e) = d1.batch(statements).await {
        return slug_race_or(e);
    }

    let created: Option<IdRow> = d1
        .prepare("SELECT id FROM posts WHERE slug = ?")
        .bind(&[text(&slug)])?
        .first(None)
        .await?;
    let id = created.map(|r| r.id).unwrap_or(0);
    Response::from_json(&json!({ "id": id, "slug": slug, "updated_at": now }))
        .map(|r| r.with_status(201))
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
    if let Some(expected) = &input.expected_updated_at {
        if *expected != current.updated_at {
            return update_conflict(Some(current.updated_at));
        }
    }

    let status = input.status.as_deref().unwrap_or(&current.status);
    // 値が今と同じなら手で決めたことにしない。編集画面が読んだ値を送り返しても、仮の slug と日付は固定されない
    let explicit_slug = input.slug.as_ref().filter(|s| **s != current.slug);
    let explicit_date = input
        .published_at
        .as_ref()
        .filter(|at| **at != current.published_at);
    let publishing = status == "published" && current.status == "draft";
    let now = now_iso();
    let published_at = match explicit_date {
        Some(at) => at.clone(),
        None if publishing && current.date_unset => now.clone(),
        None => current.published_at.clone(),
    };
    let slug = match explicit_slug {
        Some(s) => s.clone(),
        None if publishing && !current.slug_fixed => {
            let Some(base) = slug_from_published_at(&published_at) else {
                return json_error("could not build a slug", 400);
            };
            match unique_slug(&d1, &base, Some(id)).await? {
                Some(s) => s,
                None => return json_error("could not build a unique slug", 409),
            }
        }
        None => current.slug.clone(),
    };
    if slug != current.slug {
        let taken: Option<IdRow> = d1
            .prepare("SELECT id FROM posts WHERE slug = ? AND id != ?")
            .bind(&[text(&slug), num(id)])?
            .first(None)
            .await?;
        if taken.is_some() {
            return json_error("slug already exists", 409);
        }
    }
    // 公開中の記事は必ず固定する。デプロイの合間に旧コードが slug_fixed = 0 のまま作った公開済みの行もここで直る
    let published = status == "published";
    let slug_fixed = current.slug_fixed || explicit_slug.is_some() || published;
    let date_fixed = !current.date_unset || explicit_date.is_some() || published;
    let updated_at = next_updated_at(&now, &current.updated_at);
    let guard = input.expected_updated_at.as_deref().unwrap_or_default();

    // 本体の UPDATE を最後に置く。それまでの文は、記事が guard の時刻のままのときだけ書く
    let mut statements = Vec::new();
    // categories を省略したときは今のカテゴリを触らない
    if let Some(categories) = &input.categories {
        statements.push(
            d1.prepare(
                "DELETE FROM post_categories WHERE post_id = ? AND (? = '' OR EXISTS \
                 (SELECT 1 FROM posts WHERE id = ? AND updated_at = ?))",
            )
            .bind(&[num(id), text(guard), num(id), text(guard)])?,
        );
        statements.extend(category_statements(&d1, categories, true, num(id), guard)?);
    }
    statements.push(
        d1.prepare(
            "UPDATE posts SET slug = ?, title = ?, content = ?, excerpt = ?, status = ?, \
             published_at = ?, slug_fixed = ?, date_fixed = ?, updated_at = ? \
             WHERE id = ? AND (? = '' OR updated_at = ?)",
        )
        .bind(&[
            text(&slug),
            text(input.title.trim()),
            text(&input.content),
            text(&make_excerpt(&input.content, 120)),
            text(status),
            text(&published_at),
            num(slug_fixed as i64),
            num(date_fixed as i64),
            text(&updated_at),
            num(id),
            text(guard),
            text(guard),
        ])?,
    );
    let results = match d1.batch(statements).await {
        Ok(results) => results,
        Err(e) => return slug_race_or(e),
    };
    let changed = results
        .last()
        .and_then(|r| r.meta().ok().flatten())
        .and_then(|m| m.changes)
        .unwrap_or(0);
    if changed == 0 {
        // 確かめてから書くまでの間に、他の保存が割り込んだ
        let latest = fetch_post(&d1, "id = ?", num(id), true).await?;
        return update_conflict(latest.map(|p| p.updated_at));
    }

    Response::from_json(&json!({ "id": id, "slug": slug, "updated_at": updated_at }))
}

// ---- ティア ------------------------------------------------------------

fn tier_config(env: &Env) -> std::result::Result<TierConfig, String> {
    let var = |name: &str| env.var(name).ok().map(|v| v.to_string());
    TierConfig::parse(
        var("TIER_MODEL").as_deref(),
        var("TIER_THRESHOLD_LONG").as_deref(),
        var("TIER_THRESHOLD_SHORT").as_deref(),
    )
}

/// 判定だけをして、書き込まない。
async fn classify_post(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let config = match tier_config(&ctx.env) {
        Ok(config) => config,
        Err(message) => {
            console_error!("tier config: {message}");
            return json_error("tier settings are invalid", 500);
        }
    };
    let Ok(ai) = ctx.env.ai("AI") else {
        return json_error("AI binding is not configured", 503);
    };
    let d1 = ctx.env.d1("DB")?;
    let Some(post) = fetch_post(&d1, "id = ?", num(id), true).await? else {
        return json_error("Not Found", 404);
    };

    let length = tier::visible_length(&post.content);
    let gate = Gate::of(length);
    let state = tier::clef_state(&post.title, &post.categories, &post.content);
    let request = clef::build_request(&config.model, gate, &state);
    let raw = match clef::run(&ai, &config.model, &request).await {
        Ok(raw) => raw,
        Err(e) => {
            console_error!("clef call failed: {e}");
            return json_error("classification failed", 502);
        }
    };
    let answer = match clef::read_answer(&raw) {
        Ok(answer) => answer,
        Err(e) => {
            console_error!("clef response unreadable: {e}; response: {raw}");
            return json_error("classification response was not understood", 422);
        }
    };
    let Some(pick) = gate.pick_of(&answer.choice) else {
        console_error!("clef chose {:?}, not offered for {gate:?}", answer.choice);
        return json_error("classification response was not understood", 422);
    };
    let verdict = tier::decide(gate, pick, answer.confidence, config.thresholds.of(gate));
    Response::from_json(&Classification {
        tier: verdict.tier.number(),
        confidence: answer.confidence,
        fallback: verdict.fallback,
        gate,
        length,
        probabilities: answer.probabilities,
    })
}

/// 本文と `updated_at` には触れない。ロックの確認と書き込みは 1 つの条件つき UPDATE で行う。
async fn set_tier(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if !is_admin(&req, &ctx.env) {
        return json_error("Unauthorized", 401);
    }
    let Some(id) = ctx.param("id").and_then(|v| v.parse::<i64>().ok()) else {
        return json_error("id must be a number", 400);
    };
    let input: TierInput = match req.json().await {
        Ok(v) => v,
        Err(_) => return json_error("Invalid JSON body", 400),
    };
    let write = match tier::parse_tier_write(&input) {
        Ok(write) => write,
        Err(message) => return json_error(message, 400),
    };

    let d1 = ctx.env.d1("DB")?;
    let statement = match &write {
        TierWrite::Manual { tier } => d1
            .prepare(
                "UPDATE posts SET tier = ?, tier_confidence = NULL, tier_locked = 1 WHERE id = ?",
            )
            .bind(&[num(tier.number()), num(id)])?,
        TierWrite::Auto { tier, confidence } => d1
            .prepare(
                "UPDATE posts SET tier = ?, tier_confidence = ? WHERE id = ? AND tier_locked = 0",
            )
            .bind(&[num(tier.number()), JsValue::from_f64(*confidence), num(id)])?,
        TierWrite::Unlock => d1
            .prepare("UPDATE posts SET tier_locked = 0 WHERE id = ?")
            .bind(&[num(id)])?,
    };
    let changed = statement
        .run()
        .await?
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);

    let state: Option<TierStateRow> = d1
        .prepare("SELECT tier, tier_confidence, tier_locked FROM posts WHERE id = ?")
        .bind(&[num(id)])?
        .first(None)
        .await?;
    let Some(state) = state else {
        return json_error("Not Found", 404);
    };
    if changed == 0 {
        return json_error("tier is locked", 409);
    }
    Response::from_json(&json!({
        "id": id,
        "tier": state.tier,
        "tier_confidence": state.tier_confidence,
        "tier_locked": state.tier_locked != 0,
    }))
}

#[derive(Deserialize)]
struct TierStateRow {
    tier: Option<i64>,
    tier_confidence: Option<f64>,
    tier_locked: i64,
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
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
    // 認証つきの応答には下書きが入りうるので、前段のキャッシュに載せない
    let authenticated = req.headers().has("Authorization")?;
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
        .post_async("/api/posts/:id/classify", classify_post)
        .patch_async("/api/posts/:id/tier", set_tier)
        .delete_async("/api/posts/:id", delete_post)
        .post_async("/api/images", images::upload_image)
        .run(req, env.clone())
        .await;

    let response = match result {
        Ok(r) => r,
        Err(e) => {
            console_error!("unhandled error: {e}");
            json_error("Internal Server Error", 500)?
        }
    };
    let mut response = with_cors(response, &env)?;
    if authenticated {
        response.headers_mut().set("Cache-Control", "no-store")?;
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(content: &str) -> PostSummaryRow {
        PostSummaryRow {
            id: 1,
            slug: "2019/11/23/031344".into(),
            title: "t".into(),
            content: content.into(),
            excerpt: "e".into(),
            status: "published".into(),
            published_at: "2019-11-22T18:13:44Z".into(),
            tier: Some(2),
            tier_confidence: Some(0.7),
            tier_locked: 0,
        }
    }

    #[test]
    fn summary_has_thumbnail_but_not_content() {
        let value =
            serde_json::to_value(PostSummary::from(row("本文\n\n![a](/img/a.png)"))).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object["thumbnail"], "/img/a.png");
        assert!(!object.contains_key("content"));
    }

    fn post_row() -> PostRow {
        PostRow {
            id: 1,
            slug: "2019/11/23/031344".into(),
            title: "t".into(),
            content: "本文".into(),
            excerpt: "e".into(),
            status: "published".into(),
            published_at: "2019-11-22T18:13:44Z".into(),
            created_at: "2019-11-22T18:13:44Z".into(),
            updated_at: "2019-11-22T18:13:44Z".into(),
            legacy_url: None,
            slug_fixed: 1,
            date_fixed: 1,
            tier: Some(2),
            tier_confidence: Some(0.7),
            tier_locked: 1,
        }
    }

    fn tier_keys(value: &serde_json::Value) -> Vec<&String> {
        value
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with("tier"))
            .collect()
    }

    #[test]
    fn summary_shows_tier_only_for_admins() {
        let admin = serde_json::to_value(summary_for(row("本文"), true)).unwrap();
        assert_eq!(admin["tier"], 2);
        assert_eq!(admin["tier_confidence"], 0.7);
        assert_eq!(admin["tier_locked"], false);
        let public = serde_json::to_value(summary_for(row("本文"), false)).unwrap();
        assert!(tier_keys(&public).is_empty());
    }

    #[test]
    fn post_shows_tier_and_editing_fields_only_for_admins() {
        let admin = post_json(&post_for(post_row(), true), true).unwrap();
        assert_eq!(admin["tier"], 2);
        assert_eq!(admin["tier_locked"], true);
        for key in ADMIN_ONLY_FIELDS {
            assert!(admin.get(*key).is_some(), "{key}");
        }
        let public = post_json(&post_for(post_row(), false), false).unwrap();
        assert!(tier_keys(&public).is_empty());
        for key in ADMIN_ONLY_FIELDS {
            assert!(public.get(*key).is_none(), "{key}");
        }
        assert_eq!(public["content"], "本文");
    }

    #[test]
    fn summary_thumbnail_is_null_without_image() {
        let value = serde_json::to_value(PostSummary::from(row("画像なし"))).unwrap();
        assert!(value.as_object().unwrap()["thumbnail"].is_null());
    }
}
