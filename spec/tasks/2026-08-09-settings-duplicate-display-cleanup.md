---
task: settings-duplicate-display-cleanup
project: Concordia
kind: 実装
status: pending
created: 2026-08-09
source_session: lictor-cda8a337-d0f2-47ee-aa8a-639329b9fd55
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/tasks/2026-08-09-settings-webui-consolidation.md
---
# 設定ページの重複表示を解消する (W5-3 の残作業)

## 目的

W5-3 で設定ページに 「すべて」 セクション (レジストリ全項目) を追加した結果、
**同じスカラー設定が既存の個別セクションとレジストリの両方に出ている**。
どちらで変えればよいか分からず、 片方だけ見て 「変えたのに反映されない」 と誤解する原因になる。

W5 の完了条件 「集約後に重複表示が残っていないこと」 の未達分がこれ。

## なぜ個別セクションを単純削除できないか

個別セクションは汎用レジストリが持てない機能を担っている。 消すとその機能ごと失われる。

| セクション | レジストリで代替できない機能 |
|---|---|
| 連携 (Slack / Discord / Revisor) | トークンの疎通検証、 bot の起動 / 停止 / 再起動、 接続状態の表示 |
| リアクション WF | 絵文字 → アクション対応表の CRUD |
| 定期実行 (cron) | job → call 対応表の CRUD |
| コスト予算 | 消費状況の可視化 |
| ワークスペース | 複数ルートの検証付き編集 |
| Lictor | mode と実行パスの自動検出 |
| Web ホスト | `concordia.config.json` 経由 (DB / env ではないのでレジストリ対象外) |

## 完了条件

- 各スカラー設定の編集経路が**ちょうど 1 箇所**になっている
  (レジストリ側に寄せるか、 個別セクション側に残すかを項目ごとに決める)。
- 個別セクションからスカラー項目を外した場合、 そのセクションには
  「値の編集は 設定 > すべて」 と分かる導線が残っている (機能が消えたように見せない)。
- レジストリ側に残した項目のうち、 個別セクションでしかできない操作
  (疎通検証・再起動等) には、 その操作への導線が出ている。
- Web ホストはレジストリ対象外である旨が UI から分かる。
- 重複が残っていないことを確認し、 結果を PR 説明に書く。
- `npx vitest run` が全て通る。

## スコープ (編集可ディレクトリ)

- `web/src/pages/settings/` (`sections/` 配下の 7 コンポーネントと `Settings.tsx`)
- `web/src/pages/{SlackConfig,DiscordConfig,RevisorConfig}.tsx` の設定セクション部分
- `spec/tasks/` (この md)

## 触らないもの

- `src/config/settings/` のレジストリ定義 (項目の増減はこのタスクの目的ではない)
- 並行 PR の領域 — `src/discord/bot.ts` の設定解決、 ワークフロー有効化フラグ `workflow.*`、
  RWF のアクション追加と Discord UI

## 設計上の注意

- 「どちらが正か」 を UI が黙って決めない。 項目ごとの判断理由を PR 説明に残す。
- 入力 UI は Memoria の `.foundation-form` 相当に合わせる (既存セクションと揃える)。
