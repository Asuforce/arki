# デプロイとバックアップ

Cloudflare のリソース（D1、R2、独自ドメイン）は、このリポジトリの外（Terraform など）で管理する想定です。このリポジトリは Worker のコードを出すだけです。

## デプロイ

```bash
cd backend  && npx wrangler deploy
cd frontend && npm run build && npx wrangler deploy --config dist/server/wrangler.json
```

- フロントは Pages ではなく、静的ファイル付きの Worker です（`@astrojs/cloudflare` の出力）。フロントでは KV と Images のバインディングは使いません（Images は API の Worker が使います）。
- フロントは API を `fetch()` で呼びます。同じゾーンの Worker 同士は、相手が Workers の **独自ドメイン** に載っていれば公開 URL で呼べます（ルートや workers.dev では失敗します）。API にも独自ドメインを付けてください。
- 独自ドメインの設定には Worker が先に存在している必要があります。先に両方を一度デプロイしてから、ドメインを割り当てます。
- 本番の `ADMIN_TOKEN` は `npx wrangler secret put ADMIN_TOKEN` で設定します。

## GitHub Actions で自動デプロイ

`.github/workflows/deploy.yml` が main の ci が成功したあとに、D1 のマイグレーション、バックエンド、フロントエンドの順にデプロイします。実際の値はリポジトリに置かず、GitHub の設定で渡します。

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Workers と D1 を編集できるトークン |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウント ID |
| Variable | `ARKI_D1_DATABASE_ID` | D1 データベースの ID |
| Variable | `ARKI_BLOG_ORIGIN` | ブログの URL（CORS 用、例: `https://blog.example.com`） |
| Variable | `ARKI_API_URL` | API の URL（独自ドメイン） |
| Variable | `ARKI_IMAGE_BASE_URL` | 画像配信の URL（R2 の公開ドメイン。API が画像の URL を作るのに使うので必須） |
| Variable | `ARKI_SITE_TITLE` | サイト名（任意） |

API の Worker は R2 のバケット `arki-images`（バインディング `IMAGES_BUCKET`）と Images（バインディング `IMAGES`）を使います。デプロイ用のトークンには、これらを持つ Worker をデプロイできる権限が要ります。Images は、アップロードのたびに一意の変換として数えられ、月 5,000 件まで無料です。アカウントが旧 Image Resizing の課金のままだと、バインディングを使えません（エラー 9432）。ダッシュボードで Images のプランに切り替えてください。

`ADMIN_TOKEN` は一度だけ手元で `npx wrangler secret put ADMIN_TOKEN` を実行して設定します（Worker に保存され、デプロイでは消えません）。

## バックアップ

記事は git に入らないので、次の 2 つで守ります。

- D1 の Time Travel: 一定期間内の好きな時点に戻せます（`npx wrangler d1 time-travel restore arki-db --timestamp=...`）。
- 書き出し: `npx wrangler d1 export arki-db --remote --output=arki-YYYYMMDD.sql` を定期的に実行し、**非公開** の場所（private な R2 やローカル）に置きます。このリポジトリには置かないでください。
