---
task: mmtask-ui-adopt-interaction-ui
project: Concordia
kind: 実装
status: pending
created: 2026-08-09
source_session: lictor-2486e1de-37fa-454c-b2ce-e69443befb1f
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/feature/workflow-toggles-and-permission-noise.md
  - spec/tasks/2026-08-08-rwf-pr-actions-and-panel-ui.md
---

# `/mmtask` の UI を共通部品 (interaction-ui) に載せ替えて二重実装を解消する

## 目的

W4 で `src/discord/interaction-ui.ts` を embed + select menu + button の**正本**として追加した。
`/mmtask` の UI を実装中の別セッションは独自の描画関数を持っているため、このままだと
同じ形式の描画コードが 2 系統残り、見た目と customId の書式が画面ごとにずれる。
描画の入口を 1 つに戻す。

## 前提

- `feat/rwf-pr-merge-ui` (コミット `4cf8549e`) がマージ済みであること。
- `/mmtask` 側の作業 (`src/discord/mmtask-view.ts` / `mmtask-interactions.ts` 相当) は
  2026-08-08 時点で別セッションの未コミット作業であり、main には無い。

## 完了条件

- [ ] `/mmtask` の画面が `buildPanel(spec)` を通して描画される (自前の `EmbedBuilder` /
      `ActionRowBuilder` / `ButtonBuilder` / `StringSelectMenuBuilder` を持たない)。
- [ ] `/mmtask` の customId が `encodePanelId` / `decodePanelId` で組み立て・解釈される。
      名前空間は `prpanel` / `rwf` と衝突しないものを使う。
- [ ] インタラクションの分岐が `dispatchInteraction` の 1 箇所から呼ばれる
      (`panel-interactions.ts` と同じ形。必要なら共通の dispatcher へ寄せる)。
- [ ] `interaction-ui.test.ts` と同じ形の回帰テスト (共通部品を通していること・自前描画が
      無いこと) を `/mmtask` の画面にも足す。
- [ ] `buildPanel` に `/mmtask` 固有の要求 (modal・ページング等) が足りなければ、画面側に
      描画を戻すのではなく **共通部品を拡張**して満たす。

## スコープ (編集可ディレクトリ)

- `src/discord/` (mmtask の view / interactions と `interaction-ui.ts` の拡張)
- 触れない: `pr-panel.ts` / `rwf-panel.ts` の画面仕様 (共通部品の拡張で対応する)
