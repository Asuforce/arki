# arki
日常を忘れるな

Cloudflare 上で動くブログエンジンです。はてなブログのバックアップ（`blogsync` で取得した Markdown）を取り込んで表示することもできます。

- `backend/` Cloudflare Workers の API（Rust / workers-rs）と D1 のマイグレーション
- `frontend/` Astro（SSR）で書いた表示側。見た目は [tintwork](https://github.com/Asuforce/tintwork) のトークンを使います
- `tools/` はてなブログの取り込み、画像の移行、投稿用 CLI（TypeScript）

設計は Phase 1（表示と CLI 投稿）と Phase 2（管理画面）に分けています。

## ライセンス

コードは MIT です。このコードで公開されるブログの記事は、それぞれの著者のものです。

## セットアップ

設定値（D1 の ID、ドメイン、サイト名）はリポジトリに入れません。`*.example` をコピーして自分の値を入れてください。

```bash
cp backend/wrangler.toml.example backend/wrangler.toml   # database_id と CORS_ALLOW_ORIGIN を設定
cp backend/.dev.vars.example backend/.dev.vars           # ローカル用の ADMIN_TOKEN
cp frontend/.env.example frontend/.env                   # API の URL、サイト名
```

### データベース

```bash
cd backend
npx wrangler d1 create arki-db                              # 出力された ID を wrangler.toml へ
npx wrangler d1 migrations apply arki-db --local
npx wrangler secret put ADMIN_TOKEN                         # 本番用
```

### 開発サーバー

フロントの `PUBLIC_API_URL` などは **ビルド時** に埋め込まれます。

```bash
cd backend  && npx wrangler dev     # http://localhost:8787
cd frontend && npm install && npm run dev
```

### デプロイ

```bash
cd backend  && npx wrangler deploy
cd frontend && npm run build && npx wrangler deploy --config dist/server/wrangler.json
```

フロントは Pages ではなく、静的ファイル付きの Worker としてデプロイします（`@astrojs/cloudflare` の出力）。独自ドメインの割り当てや D1・R2 の作成は、Terraform など自分の管理方法で行ってください。

### はてなブログの取り込み

`<backup-dir>` は `blogsync pull` で取得したディレクトリです。記事はリポジトリに含めず、D1 にだけ入れます。

```bash
cd tools && npm install
npx tsx import-hatena.ts <backup-dir>/<your>.hatenablog.com \
  --old-host <your>.hatenablog.com --out ./import.sql
cd ../backend
npx wrangler d1 execute arki-db --local --file=../tools/import.sql    # まず手元で確認
npx wrangler d1 execute arki-db --remote --file=../tools/import.sql
```

### 記事の投稿（Phase 1）

```bash
export ARKI_API_URL=https://<api>  ARKI_ADMIN_TOKEN=...
npx tsx tools/arki-post.ts post.md
```

`post.md` の先頭に `title`、`date`、`categories`、`status` を書きます。

## バックアップ

記事は git に入らないので、D1 の Time Travel と `wrangler d1 export arki-db --remote` で守ります。書き出したファイルはこのリポジトリに置かないでください。
