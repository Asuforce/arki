# API

Workers の API です。応答は JSON で、エラーは `{"error": "メッセージ"}` の形です。

## 認証

書き込みと下書きの参照には `Authorization: Bearer <ADMIN_TOKEN>` が要ります。トークンは Worker の secret `ADMIN_TOKEN` です。正しいトークン付きなら、公開用の GET でも下書きが見えます。

## CORS

`CORS_ALLOW_ORIGIN`（未設定なら `*`）を、エラーを含むすべての応答に付けます。`OPTIONS` は 204 を返します。

## エンドポイント

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/posts` | - | 一覧（本文なし）。`?page=1&limit=20&category=名前`、`limit` は最大 50 |
| GET | `/api/posts/by-slug/<slug>` | - | 記事 1 件（本文とカテゴリ付き）。無ければ 404 |
| GET | `/api/categories` | - | カテゴリと公開記事の数 |
| GET | `/api/posts/:id` | 要 | id で記事 1 件（編集用） |
| POST | `/api/posts` | 要 | 作成。201 で `{ "id", "slug" }` |
| PUT | `/api/posts/:id` | 要 | 更新。200 で `{ "id", "slug" }` |
| DELETE | `/api/posts/:id` | 要 | 削除。204 |

エラー: 認証なしは 401、入力の誤りは 400、slug の重複は 409、無ければ 404。

## 一覧の応答

```json
{
  "posts": [
    {
      "id": 1, "slug": "2019/11/23/031344", "title": "...", "excerpt": "...",
      "status": "published", "published_at": "2019-11-22T18:13:44Z", "categories": ["game"]
    }
  ],
  "page": 1, "limit": 20, "total": 1831
}
```

並びは `published_at` の新しい順です。

## 作成と更新の入力

```json
{
  "title": "必須",
  "content": "必須。Markdown",
  "status": "draft | published",
  "published_at": "2019-11-22T18:13:44Z",
  "slug": "2019/11/23/031344",
  "categories": ["game"]
}
```

| 項目 | 作成のとき | 更新のとき（省略） |
|---|---|---|
| `status` | `draft` | 今の値のまま |
| `published_at` | 今 | 今の値のまま |
| `slug` | `published_at`（JST）から作る | 今の値のまま |
| `categories` | なし | 今のカテゴリのまま。`[]` を渡すと全部外す |

`title` と `content` は更新でも必須です。カテゴリの書き込みは 1 回のバッチで行います。
