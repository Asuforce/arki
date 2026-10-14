# 公開 API の読み取り行数と、書き込みの入力量に上限を置く

D1 は、読み取った**行数**で使用量を数える。このアカウントの Workers は Free（2026-10-14 に確認）で、読み取りが 1 日 500 万行、書き込みが 1 日 10 万行
までで、超えるとその日のクエリは失敗する（2026-09-01 から強制）。Paid では、超えた分が従量課金になる。
Cloudflare の予算アラートは通知だけで、利用を止めない。使用量を抑える仕組みは、コードの中で持つ。

このファイルは、直すときの設計と、直したことを確かめる手順を残す。**コードは、まだ変えていない。**

## 1. 公開の一覧は、記事数に比例して行を読む

`GET /api/posts`（`backend/src/lib.rs` の `list_posts`）は、管理者と公開で同じ SQL を使い、`status` などの絞り込みを
`(? = 1 OR p.status = 'published') AND (? = '' OR ...)` というバインド値の分岐で書いている。この形は、
`idx_posts_status_published` を使えない。ローカルの SQLite 3.45.1 で `EXPLAIN QUERY PLAN` を取ると、
公開ユーザーの `COUNT(*)` も `SELECT` も、全件走査になる。

```text
-- 今: 公開ユーザー（COUNT と SELECT のどちらも）
SCAN p
USE TEMP B-TREE FOR ORDER BY            -- SELECT のみ

-- 公開専用の SQL（WHERE status = 'published'）にしたとき
SEARCH posts USING COVERING INDEX idx_posts_status_published (status=?)    -- COUNT
SEARCH posts USING INDEX idx_posts_status_published (status=?)             -- SELECT
USE TEMP B-TREE FOR RIGHT PART OF ORDER BY                                 -- SELECT。id の同順位の整列だけ
```

1 回の一覧で読む行数は、おおよそ `2 × 記事数`（`COUNT` と `SELECT` の走査）。トップ、`/page/N`、
`/category/X`、`/rss.xml` が、表示のたびに API を呼ぶので、読み取りは閲覧数に比例して増える。
記事が 1,800 件なら 1 回で約 3,600 行なので、Free の 1 日の上限（500 万行）は、約 1,400 回で使い切る。
**実際の記事数と、本番の実行計画は、確認していない**（D1 は SQLite ベースだが、本番の計画は未確認）。

### 直し方

1. 公開用のクエリを、管理者用から分ける。公開は
   `WHERE p.status = 'published' ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?` とし、
   カテゴリの絞り込みは `post_categories` から引く。管理者用は今のまま
2. `total`（件数）は、数分キャッシュする。`COUNT(*)` は、カバリングインデックスでも、公開記事数ぶんの索引エントリを読む
3. `page` が `ceil(total / limit)` を超えたら、クエリの前に 404 を返す
4. `idx_posts_status_published` に `id DESC` を足すと、`ORDER BY` の一時ソートも消せる（`(status, published_at DESC, id DESC)`）。
   マイグレーションが 1 本増えるので、1〜3 の効果を見てから決める
5. 公開 GET の応答を、Cache API（`caches.default`）に載せる。現状、API の応答には `Cache-Control` が無く、
   フロントのページが付けている `s-maxage=600` を、エッジが保存するかも**未確認**（`cf-cache-status` で確認する）

### 挙動が変わるところ

| 変更 | 変わること |
| --- | --- |
| 公開クエリの分離 | 応答の中身は変わらない |
| `total` のキャッシュ | 新しく公開した直後は、ページ数が最大でキャッシュの時間ぶん古い |
| `page` の上限 | 範囲外の `page` が、空の一覧ではなく 404 になる |
| 応答のキャッシュ | 公開した記事が、最大でキャッシュの時間ぶん遅れて見える |

## 2. 書き込みの入力量に、上限が無い

記事の作成・更新（`create_post`、`update_post`）は、本文の長さ、タイトルの長さ、カテゴリの件数に上限が無い。
カテゴリは 1 件ごとに 2 文を `batch` に足す（`category_statements`）。画像（`POST /api/images`）は
1 枚 10 MB までだが、枚数に上限が無い。Cloudflare Images の binding は、ユニークな変換ごとに課金される
（Paid は月 5,000 件を超えると $0.50 / 1,000 件。Free は 5,000 件を超えると、新しい変換が 9422 で失敗し、課金は無い）。
アニメーション画像は、変換せずに最大 10 MB のまま R2 に置く。

正常な使い方（管理画面からの手入力）では当たらない値で、異常な入力が来たときに、被害を有限にするための上限を置く。

| 定数 | 既定 | 超えたとき |
| --- | --- | --- |
| `MAX_TITLE_CHARS` | 200 | 400 |
| `MAX_CONTENT_BYTES` | 512 KiB | 413 |
| `MAX_CATEGORIES_PER_POST` | 20 | 400 |
| `MAX_IMAGES_PER_DAY` | 200 | 429 |
| `MAX_IMAGE_BYTES_PER_DAY` | 200 MiB | 429 |

- 既定値は、**現在の記事の最大の大きさ**と、画像を載せる普段のペースを見てから決める。見る前は暫定
- 定数はコードに置き、`wrangler.toml` の `[vars]` で上書きできるようにする。数として読めないときは既定値に戻す
- 画像の日次の上限は、D1 に 1 行のカウンタ（日付、枚数、バイト数）を置く。書き込みは、アップロード 1 回につき 1 行
  増えるだけ。カウンタの更新に失敗したら、アップロードは通さない（止まる側に倒す）
- 本文の上限は、D1 の 1 値の上限（2 MB）より低く置く。2 MB に当たってから D1 のエラーで落ちるのを避ける

## 3. そのほか

- **`deploy.yml` と `ci.yml` に `timeout-minutes`。** 今は、ハングしたジョブが既定の 360 分まで走る。
  バックエンドのデプロイは、毎回 `worker-build` を入れてビルドするので、キャッシュなしの所要時間を、実績で見てから決める
- **`import-hatena.ts` は全件入れ替え。** 1 回の取り込みで、記事・索引・カテゴリのリンクの削除と挿入が数万行になる
  （記事 1,800 件の概算）。Free の 1 日の書き込み上限（10 万行）の大半を使うので、本番への取り込みは 1 日 1 回までにする。
  `docs/hatena-import.md` に、この制約を一行足す
- **Rate Limiting とキルスイッチ**は、Cloudflare 側の設定（ゾーンの Rate Limiting ルール）と、別の repo の Terraform で扱う。
  この repo では、上限（1、2）で、リクエスト 1 回あたりの被害を有限にする

## 見送るもの

- **`wrangler.toml` の `[limits]`（`cpu_ms`、`subrequests`）。** 公式 docs で Standard usage model（Paid）のみ対応とある。
  Free で足すと、デプロイが通らない可能性がある。Paid に上げるときに、画像の変換の CPU 時間を測って決める
- **Workers の Rate Limiting binding。** Free で使えるかを、公式 docs で確認できていない

## 確かめ方

```bash
# 1. 実行計画。migrations から作った DB に、今の SQL と直した SQL を当てる
python3 - <<'EOF'
import sqlite3, glob
db = sqlite3.connect(":memory:")
for f in sorted(glob.glob("backend/migrations/*.sql")):
    db.executescript(open(f, encoding="utf-8").read())
db.executemany(
    "INSERT INTO posts (slug,title,content,excerpt,status,published_at) VALUES (?,?,?,?,?,?)",
    [(f"s{i}", f"t{i}", "x", "e", "published", "2020-01-01T00:00:00Z") for i in range(1800)],
)
sql = ("SELECT id FROM posts WHERE status='published' "
       "ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?")
for row in db.execute("EXPLAIN QUERY PLAN " + sql, (20, 0)):
    print(row[3])
EOF
```

- 直す前後で、`SCAN p` が `SEARCH ... INDEX idx_posts_status_published` に変わること。上の手順は `id` だけを選ぶので、`COVERING INDEX` と表示される。`(status, published_at DESC, id DESC)` の索引を足して試すと、一時ソートの行も消える（ローカルで確認済み）
- ローカルの D1（`wrangler dev`、`--local`）で、一覧を 1 回呼んだ `meta.rows_read` が、記事数によらず `limit` 前後になること
- 本番では、D1 の Metrics の Row Metrics で、1 日の Rows read が下がること
- 上限は、ちょうどの値（通る）と、1 つ超えた値（400 / 413 / 429）の両方で、確かめるテストを足す

## 確認が要ること

- 実際の記事数と、1 記事の最大の大きさ
- 公開ページと API の応答が、エッジでキャッシュされているか（`cf-cache-status`）
- Images のプランが、実際に Free か（Workers は、2026-10-14 に Free と確認した）
- Rate Limiting binding が、Workers Free で使えるか
