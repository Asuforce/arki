# 記事を投稿する（Phase 1）

管理画面はまだありません（Phase 2 で追加します）。Markdown ファイルを送る CLI を使います。

```bash
export ARKI_API_URL=https://<api の URL>
export ARKI_ADMIN_TOKEN=<ADMIN_TOKEN>
cd tools && npm install
npx tsx arki-post.ts post.md
```

## ファイルの形

```markdown
---
title: 題名
date: 2026-10-10T09:00:00+09:00
categories: [日記, ごはん]
status: published
---

本文（Markdown）
```

| 項目 | 内容 |
|---|---|
| `title` | 必須 |
| `date` | 公開日時。省略すると今 |
| `categories` | 省略すると空 |
| `status` | `published` 以外は下書き |
| `slug` | 省略すると `date` から作る |

同じ `slug` の記事があれば更新、なければ作成します。CLI は毎回 `status` と `categories` を送るので、ファイルに書いていない項目は既定値になります。
