---
task: cc-inject-one-line-notice
project: Concordia
kind: 実装
status: review
created: 2026-09-30T00:00:00.000Z
source_session: lictor-a48e1d5b-2b5b-468a-a32d-b6e40f29edd7
memoria_task_id: null
pr_number: null
actio_task_id: actio:4cbaefc9-2e65-42cc-b7f8-79f5ec667f57
memory_links: []
---
# Cc inject の Discord 通知を全文から 1 行へ

設計正本: `spec/feature/discord-session-task-post.md` §3.6。

## 目的

Revisor #2181 で Cc 由来 inject を session thread へ最大 1900 文字で全文転記したところ、
policy update や project rules が長く、通知として多すぎた (2026-09-30 neco)。何が起きたか
(ポリシー更新・ブランチ切替など) だけが分かる 1 行通知に置き換える。

### 変更内容

- `src/discord/cc-inject-mirror.ts` に純関数 `summarizeCcInject(text)` を追加し、
  `ccInjectMirrorPost` の content をその 1 行に変更 (1900 文字切り詰めと `…(以下省略)` を削除)。
- 1 行化の規則: 先頭行が `[タグ] 残り` なら `タグ: 要旨` (残りが空なら後続行の `key:` を最大 5 個、
  無ければ次の行)。それ以外は先頭行。連続空白を潰し、150 文字超は 149 文字 + `…`。
- 転記可否 (人間発言・Enter・委託タスク本文・stall nudge の除外) と bot.ts の送信経路・username
  (`⚙️ Cc inject / <source>`) は変更しない。
- spec §3.6 を 1 行通知に改め、変更理由と規則・代表例を記載。
- Augur 契約 C-12 (`summarizeCcInject` の戻り値は改行なし 150 文字以内) と述語モジュール、
  runtime 再公開 `src/discord/ontime-runtime.ts` を追加。cc.acceptance.json に 2 ファイルの対応を追加。

### 再利用探索

- 既存の文面組み立て (`session-task-post.ts` の見出し整形など) は委託タスク本文用で、先頭タグ + key 列挙の
  要約規則を持たないため不採用。要約は既存モジュール `cc-inject-mirror.ts` 内に閉じた。
- observe runtime は `src/harness/reliability/ontime-runtime.ts` を再公開して再利用 (domain-review と同じ形)。

### 変更境界

- `cc-inject-mirror.ts` の文面組み立てのみ。送信経路・転記判定・他の Discord 投稿は不変。

### 復旧方法

- この PR を revert すれば全文転記 (最大 1900 文字) に戻る。DB・設定の変更は無い。

### 検証

- 実施: `npx vitest run src/discord/cc-inject-mirror.test.ts` (27 件 pass)、
  `tsc --noEmit -p tsconfig.json` / `-p tsconfig.test.json` (0 error)、変更ファイルの depcruise (違反なし)。
- 実在文面 (startup-policy / project-rules-inject / branch-watch / testing 交通整備 / goal-and-go /
  session-followup) の代表文字列がそれぞれ 1 行の要旨になることをテストで固定。
- 未実施: サービスの起動・再起動と Discord 上の実表示確認 (反映はマージ後に親セッションが行う)。
  Augur 契約 C-12 の観測は vitest 実行中には記録されないため、集計上は未観測。

## 完了条件

- [x] Cc 由来 inject は Discord に 1 行 (150 文字以内) だけ出る。
- [x] policy update は `Cc policy update: <変わったキー>`、ブランチ切替は `⚠️ ブランチ切替を検知しました (a → b)。` の形。
- [x] 除外対象 (人間発言・Enter・委託タスク本文・stall nudge) は従来どおり投稿されない。
