# セットアップ

## 設定ファイル

自分用の値はリポジトリに入れません。`*.example` をコピーして書き換えます（コピー先は `.gitignore` 済みです）。

| コピー先 | 元 | 書く内容 |
|---|---|---|
| `backend/wrangler.toml` | `wrangler.toml.example` | D1 の `database_id`、`CORS_ALLOW_ORIGIN`（フロントの URL）、`IMAGE_BASE_URL`（画像の URL） |
| `backend/.dev.vars` | `.dev.vars.example` | ローカル用の `ADMIN_TOKEN` |
| `frontend/.env` | `.env.example` | `PUBLIC_API_URL`、`PUBLIC_IMAGE_BASE_URL`、`PUBLIC_SITE_TITLE` |

フロントの `PUBLIC_*` は **ビルド時** に埋め込まれます。変えたら再ビルドが要ります。本番の `ADMIN_TOKEN` は `npx wrangler secret put ADMIN_TOKEN` で設定します。

## データベース

```bash
cd backend
npx wrangler d1 create arki-db      # 出力された ID を wrangler.toml へ
npx wrangler d1 migrations apply arki-db --local
```

本番は `--remote` を付けて同じコマンドを実行します。

## 開発サーバー

```bash
cd backend  && npx wrangler dev     # http://localhost:8787
cd frontend && npm install && npm run dev
```

backend の初回は `worker-build` の取得と WASM のビルドで時間がかかります。必要なもの: Rust（`wasm32-unknown-unknown` ターゲット）、Node.js 22。

## 管理画面をローカルで動かす

`/admin` は Cloudflare Access の JWT を見ます。手元では Access が無いので、`astro dev` のときだけ検査を飛ばせます。`astro build` の出力では、この迂回は効きません。

```bash
cd backend  && echo 'ADMIN_TOKEN=local-test-token' > .dev.vars && npx wrangler dev
cd frontend && ADMIN_TOKEN=local-test-token ADMIN_DEV_BYPASS=1 PUBLIC_API_URL=http://localhost:8787 npm run dev
```

`http://localhost:4321/admin` を開きます。`ADMIN_TOKEN` は API の `.dev.vars` と同じ値にします。画像のアップロードは、ローカルの R2 と Images で動きます。

## テストとチェック

```bash
cd backend  && cargo fmt --check && cargo clippy --target wasm32-unknown-unknown -- -D warnings && cargo test --lib
cd frontend && npm run check && npm test && npm run build
cd tools    && npm run typecheck && npm test
```

`frontend` のテストは、Access の JWT 検証、管理用 API クライアント、保存の本文を作る処理、JST の変換を対象にしています。

同じ内容を CI（`.github/workflows/ci.yml`）が走らせます。Rust のテストは Workers に依存しない純粋なロジック（`backend/src/util.rs`）を対象にしています。
