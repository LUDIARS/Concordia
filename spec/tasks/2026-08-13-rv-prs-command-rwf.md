---
task: rv-prs-command-rwf
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/revisor-local-pr-submission.md
  - spec/feature/reaction-workflow.md
  - spec/tasks/2026-08-08-rwf-pr-actions-and-panel-ui.md
---
# /rv-prs コマンド + RWF 📋 (Revisor local PR 一覧)

## 目的
「PR」という言葉が GitHub PR と誤解され、Revisor local PR と理解されない (neco 2026-08-13)。
Revisor の PR リストを返すコマンドが無いことが誤解の温床なので、一覧の出口を作り、
出力・コマンド説明の両方で「PR = Revisor local PR」を毎回明示的に教える。

## 完了条件
- `GET /v1/prs/revisor/digest` が Revisor local PR 一覧の Markdown を返す
  (未構成・停止中も 200 + 説明。 repository クエリで絞り込み可)。
- Discord `/rv-prs` が同ダイジェストを表示する。 説明文で「PR は原則こちら」
  「GitHub PR は /prs」を明示する。 `/prs` の説明も GitHub PR 側と明示する。
- RWF 語彙に `list-local-prs` (📋) が追加され、リアクションで同内容が返る。
  セッションチャンネルならそのリポジトリに絞る。 rwf-panel の候補に自動掲載される。
- 外部 RWF プラグインが 📋 未対応の旧版なら契約不一致として同梱実装へフォールバックし、
  Slack の `clipboard` reaction も同じ 📋 アクションへ正規化される。
- コマンドと RWF は共有実体 `src/pr/local-pr-listing.ts` に結合し、Cc 本体からは
  reader 注入 (`RevisorLocalPrReader`) だけで緩やかに分離する。
- renderer・API・Discord command・RWF・operations・loader・Slack 正規化の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/pr/
- src/api/
- src/discord/
- src/platform/
- src/slack/ (📋 reaction 名の正規化)
- src/bootstrap/ (注入の配線 1 箇所)
