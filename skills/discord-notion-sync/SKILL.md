---
name: discord-notion-sync
description: チームの Discord セクションチャンネル (チーム相談・企画相談・プログラマー・デザイナー・サウンド・プランナー) に貼られた仕様・決定事項を、指定された Notion データベースへ重複なく追記し、種類ごとに整理する。人が「Notion に取り込んで」「整理して」と頼んだときに手動で使う。自動起動・定期実行はしない。
---

# Discord セクションチャンネル → Notion 取り込み

人に頼まれたときだけ実行する。定期実行・Bot 常駐・Cc 本体の変更はこの手順に含めない。
対象チャンネル・読み取り元・照合キーの根拠は [仕様](../../spec/feature/discord-notion-sync.md) にある。

## 0. 対象を決める

1. 対象チーム (`GET /v1/teams` の `id`) と Notion の取り込み先を依頼から確定する。
   取り込み先は Notion のデータベース URL (「Discord 取り込み」DB) とその下の「取り込み記録」ページ。
   依頼に無ければ ask マーカーで聞く。勝手に新しい置き場所を作らない (下書きでも作らない)。
2. 取り込み先 DB が無いと言われた場合だけ、指定された親ページの下に作る。プロパティは次のとおり。

| プロパティ | 型 | 中身 |
|---|---|---|
| 名前 | title | 投稿の要点 (先頭 60 字程度) |
| 種類 | select | 仕様 / 決定事項 / 画像 / 質問・相談 / その他 |
| チャンネル | select | 投稿元の面の名前 (例: プランナー) |
| 投稿日時 | date | Discord の投稿時刻 |
| Source | url | 照合キー `discord:<channel_id>/<message_id>` |
| 版 | number | 取り込んだ投稿の revision (編集時刻 ms) |

Source は 1 投稿 1 ページの照合キーで、Cc の Notion 作業ページ (`src/taskflow/notion-work-pages.ts`) と
同じく url 型で完全一致検索する。Discord のジャンプ URL は guild ID を Cc が保存していないため作らない。

## 1. 新しい投稿を読む

Cc が収集した投稿を `concordia.db` から**読み取り専用**で読む。書き込み・スキーマ変更はしない。
次のスクリプトを Write ツールで scratchpad に `read-team-posts.mjs` として保存し、
Concordia 本体フォルダを cwd にして `node <scratchpadの絶対パス>/read-team-posts.mjs <team_id> <after.json の絶対パス>` で実行する。
`after.json` は取り込み記録 (§4) の `{ "<channel_id>": "<最後の message_id>" }`。初回は `{}`。

```js
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// scratchpad に置いても Concordia 本体 (cwd) の依存を解決する
const Database = createRequire(join(process.cwd(), "package.json"))("better-sqlite3");
const [team, afterPath] = process.argv.slice(2);
const after = afterPath ? JSON.parse(readFileSync(afterPath, "utf8")) : {};
const db = new Database("concordia.db", { readonly: true, fileMustExist: true });
const surfaces = new Map(db.prepare("SELECT surface, channel_id FROM team_surfaces WHERE team_id=?").all(team)
  .map((r) => [r.channel_id, r.surface]));
const rows = db.prepare(`SELECT channel_id, message_id, content, revision FROM team_discussion_messages
  WHERE team_id=? ORDER BY CAST(message_id AS INTEGER)`).all(team);
db.close();
const epoch = 1420070400000n;
const out = rows.filter((r) => !after[r.channel_id] || BigInt(r.message_id) > BigInt(after[r.channel_id]))
  .map((r) => ({ ...r, surface: surfaces.get(r.channel_id) ?? "(スレッド)",
    posted_at: new Date(Number((BigInt(r.message_id) >> 22n) + epoch)).toISOString() }));
process.stdout.write(JSON.stringify(out, null, 1));
```

- 出力は UTF-8 の JSON。PowerShell の表示で読まず、Bash でファイルへ保存してから読む。
- スレッド内の投稿は `channel_id` がスレッド ID になる (`surface` は「(スレッド)」)。親の面は
  Discord 上の表示か、同じスレッドの既存行の `チャンネル` で補う。推測で面を決めない。
- 投稿者 ID (`author_id`) は読まない・Notion に書かない。
- 0 件なら「新しい投稿なし」と報告して終える。

## 2. 種類を分ける

各投稿を本文から 1 つの種類に分ける。迷う投稿は「その他」にし、無理に仕様・決定事項にしない。

- **仕様**: 画面・ルール・数値・データ形式など「こう作る」を述べたもの。
- **決定事項**: 「〜にする」「〜で確定」など結論や合意。誰が決めたかは書かない。
- **質問・相談**: 未決の問い。答えが後の投稿にあれば両方を取り込み、本文で相互に参照する。
- **画像**: 現行の Cc は添付を収集しないので、このスキルでは取り込めない (仕様 §未対応)。
  本文に画像への言及しかない投稿は「その他」にし、「画像は Discord を参照」と書く。
- 雑談・あいさつ・絵文字だけの投稿は取り込まない。取り込まなかった件数を報告に書く。

## 3. 照合して追記する

Notion は claude.ai の Notion コネクタ (`notion-fetch` / `notion-query-data-sources` /
`notion-create-pages` / `notion-update-page`) で読み書きする。Notion API トークンを扱わない。

1. 取り込み先 DB を `notion-fetch` し、data source ID とプロパティを確かめる。
2. 投稿ごとに `Source` の完全一致で既存ページを検索する。2 件以上当たったら書き込まず報告に回す。
   - 無い → 新規ページを作る。
   - 有り・`版` が同じ → 何もしない (重複させない)。
   - 有り・`版` が新しい → 既存本文の末尾に「## 編集後 (<編集時刻>)」と新しい原文を**追記**し、
     `版` を更新する。以前の原文は消さない・書き換えない。
3. ページ本文の形は次のとおり。

```markdown
## 要約
<1〜3 行。AI の整理であることが分かる書き方にする>

## 原文
<投稿本文をそのまま。改変しない>

## 投稿元
- チャンネル: <面の名前>
- 投稿日時: <ISO 時刻>
- メッセージ: discord:<channel_id>/<message_id>
```

- 本文の秘匿語・トークンらしき文字列 (`ghp_` `sk-` `xox` で始まるもの、招待 URL の末尾コードなど) は
  `[伏字]` にし、伏字にした件数を報告する。原文欄でもこの伏字だけは例外として行う。
- メールアドレス・電話番号・住所などの個人情報は `[個人情報]` に伏せる。
  人の呼び方は投稿のままにし、投稿者を Notion に足さない。判断に迷う投稿は取り込まずに報告へ回す。

## 4. 整理と記録

1. DB に「種類」でグループ分けしたビューが無ければ `notion-create-view` で作る (既存ビューは変えない)。
2. 取り込み記録ページに、今回の結果を**追記**する。前回の記録は消さない。

```markdown
## <実行時刻>
- 取り込み: 仕様 N / 決定事項 N / 質問・相談 N / その他 N、更新 N、見送り N、伏字 N
- 続きの位置:
  ```json
  { "<channel_id>": "<最後の message_id>" }
  ```
```

次回は最新の「続きの位置」を §1 の `after.json` に使う。記録が読めない・壊れているときは `{}` で
全件を読み、§3 の照合で重複を防ぐ (照合が正本で、続きの位置は読み取り量を減らす補助)。

## 5. 報告

取り込み件数・更新件数・見送り件数と理由・作成/更新したページの URL を返す。
Notion に実際に書けたページだけを完了として数える。書き込みエラーや結果不明のものは件数を分けて書き、
同じ投稿を確認せずに再作成しない (§3-2 の照合をやり直してから判断する)。
