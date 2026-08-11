---
task: settings-webui-consolidation
project: Concordia
kind: 実装
status: done
created: 2026-08-09
source_session: lictor-cda8a337-d0f2-47ee-aa8a-639329b9fd55
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/tasks/2026-08-09-settings-admin-api.md
---
# WebUI /settings へセクション分けして集約 (W5-3)

## 完了 (2026-08-09, PR #357)

設定ページに 「すべて」 セクションを追加し、 レジストリ全項目をセクション分けで表示・編集
できるようにした。 出所バッジ (db / env / 既定 / 未設定)、 kind 別入力、 絞り込み、
まとめ保存、 拒否理由の表示。 secret は値を出さず 「設定済み / 未設定」 のみ。
env 専用は入力ではなく現在値表示にした (触れるのに効かない、 を作らない)。
`web/src/pages/settings/sections/AllSettingsSection.tsx` ほか。

**重複表示の解消だけは分離した** → [`2026-08-09-settings-duplicate-display-cleanup.md`]
(2026-08-09-settings-duplicate-display-cleanup.md)。 個別セクションは汎用レジストリが
持てない機能を担っており単純削除できず、 7 コンポーネントの改修になるため。

## 目的

W5-2 の API を読んで、 これまで DB / env にしか無かった設定を含む**全項目**を
`/settings` にセクション分けで表示・編集できるようにする。 既存の個別ページ
(Discord / Slack / Revisor / Lictor / ReactionWorkflow 等) をこのレジストリを読む形へ寄せ、
設定ページに集約する。

前提: `2026-08-09-settings-admin-api.md`。

## 完了条件

- `/settings` に全項目がセクション分けで表示され、 各項目に 現在値 / 出所 (`db|env|default|none`) /
  既定値 / 説明 が出る。 出所が分かることで 「これは env でしか変えられない」 が UI で判別できる。
- secret 系は値を表示せず 「設定済み / 未設定」 のみ表示する。 入力は書き込み専用。
- 既存の個別ページはレジストリを読む形へ寄せる。 **ページを消すかどうかは
  「集約後に重複表示が残らないこと」 を優先して判断し、 判断理由を PR 説明に書く**。
- 集約後に設定の重複表示が残っていないことを確認し、 結果を PR 説明に書く。
- `npx vitest run` が全て通る。

## スコープ (編集可ディレクトリ)

- `web/src/pages/settings/` (既存 `sections/` の作りを踏襲)
- `web/src/` (API クライアント等、 設定ページから辿る範囲)
- `spec/tasks/` (この md)

## 設計上の注意

- 入力 UI は Memoria の `.foundation-form` 相当 (角丸 + やや大きめ padding) の既存スタイルに合わせる。
- セクション定義 / 項目描画 / API クライアント を 1 ファイルに詰め込まない (SRP)。
- 1 行に詰め込んだ圧縮コードを書かない。

## 反映手順 (PR 説明に書く)

Concordia は dist 実行のため、 マージ後に `npm run build` と Excubitor 経由の再起動が必要。
**再起動はこのタスクでは実施しない**。
