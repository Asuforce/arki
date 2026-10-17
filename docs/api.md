# API

Workers の API です。応答は JSON で、エラーは `{"error": "メッセージ"}` の形です。

## 認証

書き込みと下書きの参照には `Authorization: Bearer <ADMIN_TOKEN>` が要ります。トークンは Worker の secret `ADMIN_TOKEN` です。正しいトークン付きなら、公開用の GET でも下書きが見えます。

## CORS

`CORS_ALLOW_ORIGIN`（未設定なら `*`）を、エラーを含むすべての応答に付けます。`OPTIONS` は 204 を返します。

## エンドポイント

| メソッド | パス | 認証 | 内容 |
|---|---|---|---|
| GET | `/api/posts` | - | 一覧（本文なし）。`?page=1&limit=20&category=名前&month=2019-11`（`month` は JST の年月）、`limit` は最大 50。`q=` はタイトルと本文の部分一致（100 文字まで）。認証つきなら `status=draft\|published` も使える（認証なしでは無視する） |
| GET | `/api/posts/by-slug/<slug>` | - | 記事 1 件（本文とカテゴリ付き）。無ければ 404 |
| GET | `/api/categories` | - | カテゴリと公開記事の数（認証つきなら下書きも数える） |
| GET | `/api/archive` | - | 月ごと（JST）の公開記事の数 `{"months": [{"month": "2019-11", "count": 3}]}`、新しい月から（認証つきなら下書きも数える） |
| GET | `/api/posts/:id` | 要 | id で記事 1 件（編集用） |
| POST | `/api/posts` | 要 | 作成。201 で `{ "id", "slug" }` |
| PUT | `/api/posts/:id` | 要 | 更新。200 で `{ "id", "slug" }` |
| DELETE | `/api/posts/:id` | 要 | 削除。204 |
| POST | `/api/images` | 要 | 画像のアップロード。本文は画像のバイト列そのもの。201 で `{ "url", "key", "content_type", "bytes" }` |

エラー: 認証なしは 401、入力の誤りは 400、slug の重複と更新の競合は 409、無ければ 404、画像の大きさ超過は 413、画像でない・対応しない形式は 415、読めない画像は 422、画像の変換の失敗は 502。

## 一覧の応答

```json
{
  "posts": [
    {
      "id": 1, "slug": "2019/11/23/031344", "title": "...", "excerpt": "...",
      "status": "published", "published_at": "2019-11-22T18:13:44Z", "categories": ["game"],
      "thumbnail": "https://example.com/images/a.jpg"
    }
  ],
  "page": 1, "limit": 20, "total": 1831
}
```

並びは `published_at` の新しい順です。

`thumbnail` は本文の最初の画像の URL で、画像が無ければ `null` です。保存してある値ではなく、読み出しのたびに `content` から求めます。規則は [architecture](architecture.md#一覧の抜粋) にあります。記事 1 件の応答には含まれません。

## 作成と更新の入力

```json
{
  "title": "必須",
  "content": "必須。Markdown",
  "status": "draft | published",
  "published_at": "2019-11-22T18:13:44Z",
  "slug": "2019/11/23/031344",
  "categories": ["game"],
  "expected_updated_at": "2019-11-22T18:13:44Z"
}
```

| 項目 | 作成のとき | 更新のとき（省略） |
|---|---|---|
| `status` | `draft` | 今の値のまま |
| `published_at` | 今 | 今の値のまま |
| `slug` | `published_at`（JST）から作る | 今の値のまま |
| `categories` | なし | 今のカテゴリのまま。`[]` を渡すと全部外す |

`title` と `content` は更新でも必須です。カテゴリの書き込みは 1 回のバッチで行います。

## slug と公開日時

記事には、slug と公開日時が決まったかを表す 2 つの印があります（応答の `slug_fixed` と `date_unset`）。下書きの間は、どちらも仮の値です。

- `status` を `draft` から `published` にして保存したとき（初回公開）に、決まっていない方を確定します。公開日時は、公開の瞬間にします。slug は、確定した公開日時から作り直します。同じ slug があれば `_1`、`_2` を付けます。
- `published_at` を今と違う値で送ると、公開日時を手で決めたことになります。その日時は初回公開でも保たれ、slug もそれから作られます。`slug` も同じで、今と違う値で送ったときだけ手で決めたことになります。読んだ値をそのまま送り返しても、決まったことにはなりません。
- `slug` を指定して作った記事、`published` で作った記事、はてなから取り込んだ記事は、その印が最初から決まっています。公開中の記事を保存したときも決まります。
- 決まったあとは、下書きに戻して再公開しても slug と公開日時は変わりません。

## 更新の競合

`PUT` に `expected_updated_at` を付けると、今の `updated_at` と違うときは何も書かずに 409 を返します。応答は `{ "error": "post was updated elsewhere", "updated_at": "..." }` で、`updated_at` は今の値です。省略すると確かめません。

確かめる処理と書き込みは同じバッチの中にあり、同時に来た保存のうち 1 つだけが通ります。`updated_at` は秒単位ですが、保存のたびに前の値より後ろへ進めるので、同じ秒に続けて保存しても取り違えません。`POST` と `PUT` の応答の `updated_at` が、次の保存に渡す値です。

## 画像のアップロード

`POST /api/images` の本文は画像のバイト列です。先頭のバイトで種類を決めるので、`Content-Type` は見ません。

- 受け付けるのは png、jpeg、gif、webp で、1 枚 10MB までです。SVG は受け付けません。
- 静止画は長辺 1200px 以下に縮め（拡大はしない）、AVIF（quality 70）にして R2 の `uploads/YYYY/MM/<保存する画像の SHA-256 の先頭 16 文字>.<拡張子>` に置きます。1200px は Cloudflare Images が AVIF を出力できる上限で、超えると WebP か JPEG になります。拡張子と `Content-Type` は実際の出力に合わせます。
- 複数フレームの GIF、APNG、アニメ WebP は変換せず、元の形式のまま置きます。
- 同じ月に同じ画像を上げると、同じキーになり、2 回目は書き込みません。
- 読めない画像は 422、Images 側の失敗（無料枠の超過、課金プラン、タイムアウト）は 502 です。

応答の `url` は `IMAGE_BASE_URL` とキーをつないだものです。認証つきの応答はすべて `Cache-Control: no-store` です。
