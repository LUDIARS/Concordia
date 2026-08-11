---
task: rwf-pr-actions-and-panel-ui
project: Concordia
kind: 実装
status: done
created: 2026-08-08
source_session: lictor-2486e1de-37fa-454c-b2ce-e69443befb1f
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/feature/workflow-toggles-and-permission-noise.md
  - spec/feature/revisor-local-pr-submission.md
---

# RWF の PR 提出 / マージと Discord 操作パネルの共通化 (W2 + W4)

正本: `spec/feature/workflow-toggles-and-permission-noise.md` の W2 / W4。
コミット: `4cf8549e` (ブランチ `feat/rwf-pr-merge-ui`)。

## 目的

リアクションワークフロー (RWF) から Revisor local PR を「出す」「マージする」を扱えるようにし、
Discord の操作面を embed + select menu + button の 1 形式へ揃えて描画の二重管理を作らない。

## 完了条件

- [x] `submit-pr` (📮 / 📬) が対象セッションの作業ブランチを Revisor local PR として提出する。
      実体は `POST /v1/prs/local` と同じ submitter (`SessionLocalPrSubmitter`) で、判定を複製しない。
- [x] 提出しなかった理由 (`no_branch` / `repository_not_registered` / `no_commits` / `already_open` /
      セッション未特定 / 経路未配線) を必ず人間可読で返す。無言スキップを作らない。
- [x] `merge-pr` (🔀 / 🚀) の既定が Revisor local PR のマージになる。対象の同定規則は
      `findOpenLocalPrForBranch` が正本 (提出の二重防止と同じ規則)。
- [x] local PR が無いときだけ GitHub squash merge 経路へフォールバックし、どちらを実行するかを
      応答に明記する。権限不足・マージ失敗ではフォールバックしない。
- [x] マージ認可が PR #297 の共通ヘルパー (`authorizeStaffCapability`) を経由する。認可 → 実行 →
      監査を `mergeLocalPrForRequester` に集約し、`POST /v1/prs/local/:id/merge` もそれを使う。
- [x] `submit-pr` は capability を要求しないが、実行者をログと応答に記録する。
- [x] `src/discord/interaction-ui.ts` が描画と customId の正本になり、PR 操作面と RWF の
      受付 / 結果 / アクション選択が両方これを通る (自前の embed / ActionRow が無い)。
- [x] `npx vitest run` = 325 files / 2274 tests green。`tsc` (src / test 両 config)・`depcruise` clean。

## スコープ (編集可ディレクトリ)

- `src/platform/` (RWF エンジンと PR 操作契約)
- `src/pr/` (提出 / 認可付きマージ / セッション単位の操作)
- `src/discord/` (共通 UI 部品と操作パネル)
- `src/api/prs.ts`・`src/bootstrap/core.ts`・`src/slack/bot.ts` (配線)
- 触れない: W1 (ワークフロー有効化)・W3 (許可ダイアログ)・W5 (WebUI 設定集約) の担当ファイル、
  `src/discord/bot.ts` の設定解決まわり

## 共通 UI 部品の公開インタフェース (後続の `/mmtask` UI はこれを採用すること)

`/mmtask` の UI を実装中の別セッションは、独自の描画関数を作らず以下を採用して統合する。
二重実装が残ると見た目と customId の書式が画面ごとにずれる。
引き継ぎタスクは `2026-08-09-mmtask-ui-adopt-interaction-ui.md`。

### `src/discord/interaction-ui.ts` (描画と customId の正本)

| 公開シンボル | 責務 |
|---|---|
| `buildPanel(spec: PanelSpec): RenderedPanel` | 宣言された画面 (title / description / fields / footer / tone / selects / buttons) を embed + ActionRow に落とす。Discord の上限 (select 25 件・button 5/行・5 行) を吸収し、削った分は footer に明記する |
| `panelEmbedJson(panel: RenderedPanel): APIEmbed[]` | テスト / ログ用に embed を素の JSON で読む |
| `encodePanelId(namespace, action, ...params): string` | customId を組み立てる。`:` を含む部品は例外にする (壊れた ID を出さない) |
| `decodePanelId(customId, namespace): { action, params } \| null` | 自分の namespace の customId だけを解釈する |
| 型 `PanelSpec` / `PanelField` / `PanelSelect` / `PanelSelectOption` / `PanelButton` / `PanelButtonStyle` / `PanelTone` / `RenderedPanel` | 画面の宣言と描画結果 |

### `src/discord/pr-panel.ts` (PR 提出 / マージの操作面)

`buildPrOperationPanel(state)` / `buildPrSubmitResultPanel(state, outcome, actor)` /
`buildPrMergeResultPanel(state, outcome, actor)` / `buildPrPanelId(action, sessionId)` /
`parsePrPanelId(customId)` / `PR_PANEL_NAMESPACE`。

### `src/discord/rwf-panel.ts` (RWF の受付 / 結果 / アクション選択)

`buildRwfAckPanel(input)` / `buildRwfResultPanel(input)` / `buildRwfActionSelectPanel(input)` /
`buildRwfPanelId(action, targetMessageId)` / `parseRwfPanelId(customId)` / `RWF_PANEL_NAMESPACE`。

### `src/discord/panel-interactions.ts` (操作面のインタラクション)

`isPanelInteraction(interaction)` / `handlePanelInteraction(interaction, deps)` / `PanelInteractionDeps`。
`dispatchInteraction` から 1 箇所で呼ぶ。

## 反映

Concordia は dist 実行のため、マージ後に `npm run build` と Excubitor 経由の再起動が要る
(このタスクでは実施しない)。

## 未了 (別タスクへ切り出し)

- Revisor local PR の提出は Revisor 書き込みトークンの 401 で未実施
  → `2026-08-09-revisor-workflow-token-401.md`
