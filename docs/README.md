# ドキュメント

- [setup.md](setup.md) 設定ファイル、ローカル開発、テスト
- [architecture.md](architecture.md) 構成、データ、URL、表示のルール
- [api.md](api.md) API の仕様
- [posting.md](posting.md) 管理画面での投稿
- [hatena-import.md](hatena-import.md) はてなブログの取り込みと画像の移行
- [deploy.md](deploy.md) デプロイとバックアップ
- [tier-scoring.md](tier-scoring.md) 記事のティア判定の設計

## 方針

- 記事は D1 だけで持ちます。記事、`import.sql`、`image-map.json` はリポジトリに入れません。
- 自分用の設定値（D1 の ID、ドメイン、サイト名）もリポジトリに入れません。`*.example` をコピーして使います。
- 投稿は管理画面（`/admin`）で行います。

## 調査・計画の記録

過去の調査・提案は、非公開の履歴へ移しました。現行仕様・開発・運用手順はこのリポジトリに残します。

```text
このrepo       現行仕様・開発・運用
Asuforce/docs  調査・計画・履歴
```

未対応事項は [GitHub Issues](https://github.com/Asuforce/arki/issues) で管理します。移行時に現行コードで確認した課題は [#30](https://github.com/Asuforce/arki/issues/30) を参照してください。
