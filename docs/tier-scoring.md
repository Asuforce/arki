# 記事のティア判定

状態: 設計。実装はまだありません。用語は [CONTEXT.md](../CONTEXT.md) にあります。

記事に、長文（Tier 1）、ナレッジ（Tier 2）、日記（Tier 3）のいずれかを付けます。判定には Cloudflare の Clef を使います。まずは既存の公開中の記事を一括で判定する仕組みを作り、新規記事の自動判定は別の作業にします。tier の使い道はまだ決めていません。保存して見られるところまでを範囲とします。

## 決めたこと

| 項目 | 決定 |
|---|---|
| 保存先 | D1 の `posts` に列を足す。記事に Frontmatter は無い |
| 判定モデル | Clef（Workers AI）。Jev と request の形が同じなので、後で入れ替えられる |
| 呼び出し | API の Worker が Workers AI の binding で Clef を呼ぶ。ツールは `ADMIN_TOKEN` だけを持つ |
| 一括処理 | `tools/classify-tiers.ts`（TypeScript）。Rust は migration、判定、tier の読み書きだけ |
| 公開 API | tier は認証つきの応答にだけ出す。公開の一覧、記事、RSS には出さない |
| 入力 | タイトル、カテゴリ、本文 |
| 判定の対象 | 公開中の記事。下書きは含めない |

## 判定のしくみ

```mermaid
flowchart TD
  P["公開中の記事<br/>title / categories / body"] --> L{"本文 1000 文字以上<br/>(長さの門)"}
  L -- "はい" --> A["Clef 2 択<br/>Tier 1 長文 / Tier 2 ナレッジ"]
  L -- "いいえ" --> B["Clef 2 択<br/>Tier 2 ナレッジ / Tier 3 日記"]
  A --> FA{"confidence が閾値以上"}
  B --> FB{"confidence が閾値以上"}
  FA -- "はい" --> TA["選ばれた tier"]
  FA -- "いいえ" --> T1["Tier 1 (フォールバック)"]
  FB -- "はい" --> TB["選ばれた tier"]
  FB -- "いいえ" --> T3["Tier 3 (フォールバック)"]
```

- 長さは数えられるので、コードで決めます。門を超えた記事は日記を選べず、超えない記事は長文を選べません。「長いのに日記と判定される」誤りが、構造的に起きません。
- 質問はいつも 2 択です。Clef が実際に決めているのは、短い記事ではナレッジか日記か、長い記事では長文かナレッジかです。
- フォールバックの行き先は、門を超えた記事が長文、超えない記事が日記です。どの記事にも tier が入ります。
- 1000 文字以上の雑記（ご飯とゲームだけの長いログ）も、長文になります。長さを主軸にした結果で、承知のうえです。
- `tier_confidence` には、Clef が返した `confidence` をそのまま保存します。フォールバックした行は、この値が閾値より低いことで見分けられます。

### 選択肢の説明文

Clef の `choice` は、選択肢のキーに説明文を付けて渡します。次は初期案で、較正で調整します。

| 分岐 | キー | 説明文 |
|---|---|---|
| 門を超えた | `long` | 考察、検証、設計の考え、体験を、自分の言葉で掘り下げている |
| 門を超えた | `knowledge` | 再利用できる手順や設定を、まとめて記録している |
| 超えない | `knowledge` | 再利用できる手順、設定、エラーの解決、学びがある |
| 超えない | `diary` | 感想や出来事が中心で、再利用できる知見がない |

```text
POST (Workers AI)  @cf/cloudflare/clef
{
  model: "clef",
  state: "<title>\n<categories>\n\n<body>",
  questions: {
    tier: {
      type: "choice",
      instructions: "<記事の性格を選ぶ>",
      criteria: { <分岐ごとのキーと説明文> }
    }
  }
}
```

## データ

`backend/migrations/0003_tier.sql` を足します。既存の行は、すべて `tier` が NULL、`tier_locked` が 0 です。

```sql
ALTER TABLE posts ADD COLUMN tier INTEGER CHECK (tier IN (1, 2, 3));
ALTER TABLE posts ADD COLUMN tier_confidence REAL CHECK (tier_confidence BETWEEN 0 AND 1);
ALTER TABLE posts ADD COLUMN tier_locked INTEGER NOT NULL DEFAULT 0;
```

| 列 | 意味 |
|---|---|
| `tier` | 1、2、3。NULL は未判定 |
| `tier_confidence` | Clef が返した `confidence`。人が決めた行は NULL |
| `tier_locked` | 1 のとき、自動の判定は書き込まない |

## API

どれも `ADMIN_TOKEN` が要ります。本文と `updated_at` には触れません。管理画面の更新の競合検出（[api.md](api.md#更新の競合)）を、誤って起こさないためです。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/posts/:id/classify` | 判定だけをして、書き込まない |
| PATCH | `/api/posts/:id/tier` | tier を書く |

`classify` の応答は次の形です。

```json
{
  "tier": 3,
  "confidence": 0.58,
  "fallback": true,
  "gate": "short",
  "probabilities": { "knowledge": 0.46, "diary": 0.54 }
}
```

`PATCH` は 2 通りの書き方があります。

| 本文 | 意味 | 結果 |
|---|---|---|
| `{ "tier": 2 }` | 人が決めた | `tier_confidence` を NULL にして、`tier_locked` を 1 にする |
| `{ "tier": 2, "tier_confidence": 0.91, "source": "auto" }` | バッチが決めた | `tier_locked = 0` の行にだけ書く。ロック済みなら 409 |
| `{ "tier_locked": false }` | ロックを外す | tier はそのまま |

ロックの確認と書き込みは、1 つの条件つき `UPDATE` で行います。確認から書き込みの間にロックが付いても、上書きしません。

認証つきの `GET /api/posts` と `GET /api/posts/:id` の応答に、`tier`、`tier_confidence`、`tier_locked` を足します。認証なしの応答には出しません。管理画面で tier を触る画面は、今回は作りません。

## 一括判定のツール

`tools/classify-tiers.ts` です。既存の `import-hatena.ts` などと同じく、API を `ADMIN_TOKEN` で呼びます。

```text
npx tsx classify-tiers.ts --api-url <URL> [--dry-run] [--force] [--delay-ms 500] [--limit N]
```

```mermaid
sequenceDiagram
    participant T as classify-tiers.ts
    participant A as API の Worker
    participant C as Clef
    participant D as D1
    T->>A: GET /api/posts (認証つき、公開中、tier を含む)
    A-->>T: 一覧
    loop 判定済みとロック済みを除く各記事
        T->>A: POST /api/posts/:id/classify
        A->>D: 本文を読む
        A->>C: choice (2 択)
        C-->>A: 選択肢、確率、confidence
        A-->>T: tier、confidence、fallback
        alt dry-run でない
            T->>A: PATCH /api/posts/:id/tier (source: auto)
            A->>D: UPDATE ... WHERE tier_locked = 0
        end
        T->>T: delay-ms だけ待つ
    end
```

- 対象は公開中の記事です。`tier` が入っている行（判定済み）と、`tier_locked` が 1 の行は飛ばします。途中で止まっても、同じ引数で続きから再開できます。
- `--force` は判定済みをやり直します。ロックは `--force` でも破りません。
- `--dry-run` は `classify` だけを呼び、`PATCH` を送りません。1 行 1 記事で、id、slug、長さ、分岐、tier、confidence、フォールバックの有無を出し、最後に tier ごとの件数とフォールバックの件数を出します。
- 429 と 5xx は、間隔を広げて 3 回まで再試行します。それでも失敗した記事は、記事ごとにエラーを出して次へ進み、最後に件数で報告します。
- 1 回の `classify` は Clef を 1 回だけ呼ぶので、Worker の subrequest の上限には当たりません。

## 変更の範囲

```diff
 backend/
 ├── migrations/
+│   └── 0003_tier.sql
 └── src/
+    ├── tier.rs           # 長さの門、選択肢、フォールバックの規則
+    ├── clef.rs           # Workers AI の呼び出しと応答の読み取り
     └── lib.rs            # classify と PATCH、認証つきの応答に tier を足す
 tools/
+├── classify-tiers.ts
+└── test/classify-tiers.test.ts
 docs/
+└── tier-scoring.md
```

`backend/wrangler.toml.example` に、Workers AI の binding（`[ai]`）を足します。

## 較正

閾値の 0.65 と選択肢の説明文は、根拠のある値ではありません。あなたが tier を付けた標本で確かめてから、一括判定を本番に流します。

- 標本は無作為ではなく、層ごとに抜きます。無作為に 40 件だと、長文が 2 件ほどしか入らないためです。
  - 門を超えた記事を 15 件。日次テンプレート（TL;DR、感想、ご飯）、技術記事、長い個人の記事を混ぜる。
  - 超えない記事を 25 件。技術のメモ、ゲームの記録、食べ物、旅行、参加録を混ぜる。
- 標本に `--dry-run` を通し、あなたの tier と突き合わせます。見るのは次の点です。
  - 分岐ごとの一致率と、フォールバックの割合。
  - 長文の分岐で、ナレッジに倒れた記事。避けたい誤りは「長い記事が低く見られること」なので、この数を最優先で見る。
  - 短い記事の分岐で、ナレッジと日記が入れ替わった記事。
- 閾値は分岐ごとに決めます。2 つの分岐は選択肢の組が違い、`confidence` の尺度も同じとは限りません。
- 1000 文字の門、閾値、説明文を変えたら、同じ標本でやり直します。合格基準の数値は、標本を見てからあなたが決めます。

## 本番の記事の実測

2026-10-13 に公開 API から 1831 件を読みました。

| 項目 | 結果 |
|---|---|
| 本文の長さ | 中央値 172 文字。100 文字未満が 593 件、300 文字未満が 1213 件（66%） |
| 1000 文字以上 | 161 件（9%）。2000 文字以上は 24 件、最長は 5507 文字 |
| カテゴリ | personal 762、game 504、food 186、tech 84、travel 67 |
| tech の長さ | 300 文字未満が 7 件、300 から 1000 が 32 件、1000 以上が 45 件 |
| h2、コードブロックのある記事 | どちらも 12 件 |

門を超える記事は 161 件なので、長文はこの範囲に収まります。残りの約 1670 件は、ナレッジか日記に分かれます。日記が大半になる見込みです。

## 実装の前に確かめること

次の点は公式のドキュメントで確認できていません。実装の最初に、実際に 1 回呼んで確かめます。

- 応答で、確率と `confidence` が入るフィールドの名前。`answers.<key>.choice` だけがドキュメントにある。
- `confidence` の定義。二次情報では、選んだ選択肢の確率ではなく、確率分布の集中度とされている。
- 入力が長いときの扱い。公式の表は文脈長を 64K トークンとしているが、二次情報には Workers AI が約 2K トークンで切り捨てるという報告もある。最長の記事は 5507 文字なので影響は小さいが、長文の分岐で確かめる。
- Workers AI の料金と上限、`rejectIfBusy` の扱い。
- workers-rs 0.8 で Workers AI の binding を呼べること。呼べなければ、`js_sys` で `env.AI.run` を呼ぶ。

## 見送ったこと

- 新規記事の公開時に自動で判定する処理。`classify` の実装を使い回せる。
- 管理画面での tier の表示、選択、ロックの切り替え。
- tier による一覧や RSS の絞り込み。
- 判定の履歴、モデル名の記録。モデルを替えたときは `--force` で全件を判定し直す。
