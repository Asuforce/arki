# ドキュメント

- [setup.md](setup.md) 設定ファイル、ローカル開発、テスト
- [architecture.md](architecture.md) 構成、データ、URL、表示のルール
- [api.md](api.md) API の仕様
- [posting.md](posting.md) 管理画面での投稿
- [hatena-import.md](hatena-import.md) はてなブログの取り込みと画像の移行
- [deploy.md](deploy.md) デプロイとバックアップ
- [tier-scoring.md](tier-scoring.md) 記事のティア判定の設計（実装前）

## 方針

- 記事は D1 だけで持ちます。記事、`import.sql`、`image-map.json` はリポジトリに入れません。
- 自分用の設定値（D1 の ID、ドメイン、サイト名）もリポジトリに入れません。`*.example` をコピーして使います。
- 投稿は管理画面（`/admin`）で行います。
