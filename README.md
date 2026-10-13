# arki
日常を忘れるな

Cloudflare 上で動くブログエンジンです。はてなブログのバックアップ（`blogsync` で取得した Markdown）を取り込んで表示することもできます。

- `backend/` Cloudflare Workers の API（Rust / workers-rs）と D1 のマイグレーション
- `frontend/` Astro（SSR）で書いた表示側と、投稿用の管理画面（`/admin`）。見た目は [tintwork](https://github.com/Asuforce/tintwork) のトークンを使います
- `tools/` はてなブログの取り込み、画像の移行（TypeScript）
- `docs/` 仕様と手順

記事は D1 だけに入ります。リポジトリには記事も、自分用の設定値も入れません。

## はじめる

```bash
cp backend/wrangler.toml.example backend/wrangler.toml
cp backend/.dev.vars.example backend/.dev.vars
cp frontend/.env.example frontend/.env
cd backend  && npx wrangler d1 migrations apply arki-db --local && npx wrangler dev
cd frontend && npm install && npm run dev
```

`wrangler.toml` の `database_id` などを自分の値にしてから動かします。詳しくは [docs/setup.md](docs/setup.md)。

## ドキュメント

[docs/README.md](docs/README.md) に一覧があります。

| | |
|---|---|
| [setup](docs/setup.md) | 設定ファイル、ローカル開発、テスト |
| [architecture](docs/architecture.md) | 構成、データ、URL、表示のルール |
| [api](docs/api.md) | API の仕様 |
| [posting](docs/posting.md) | 管理画面での投稿 |
| [hatena-import](docs/hatena-import.md) | はてなブログの取り込みと画像の移行 |
| [deploy](docs/deploy.md) | デプロイとバックアップ |

## ライセンス

コードは MIT です。このコードで公開されるブログの記事は、それぞれの著者のものです。
