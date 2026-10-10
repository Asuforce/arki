# ドキュメント

- [setup.md](setup.md) 設定ファイル、ローカル開発、テスト
- [architecture.md](architecture.md) 構成、データ、URL、表示のルール
- [api.md](api.md) API の仕様
- [posting.md](posting.md) Markdown を投稿する CLI
- [hatena-import.md](hatena-import.md) はてなブログの取り込みと画像の移行
- [deploy.md](deploy.md) デプロイとバックアップ

## 方針

- 記事は D1 だけで持ちます。記事、`import.sql`、`image-map.json` はリポジトリに入れません。
- 自分用の設定値（D1 の ID、ドメイン、サイト名）もリポジトリに入れません。`*.example` をコピーして使います。
- Phase 1 は表示と CLI での投稿、Phase 2 で管理画面を足します。
