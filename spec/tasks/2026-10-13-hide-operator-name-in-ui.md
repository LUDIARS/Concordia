---
task: hide-operator-name-in-ui
project: Concordia
kind: 実装
created: 2026-10-13T00:00:00.000Z
memory_links: []
---

# 画面・通知・プロンプトに運用者の名前を出さない

## 要件

人間の指示 (2026-10-13): 「Cc で使われてる neco っていう名前、Cc の画面や通知に出ないようにしてほしい」。

## 対象

- 設定画面の項目説明: `src/config/settings/definitions/session.ts`
- 委託テンプレートの説明 (Delegation 一覧に表示): `src/delegation/seed.ts`
- パートタイマー / 定例プロンプト (Discord スレッドへ mirror される): `src/delegation/parttimer-prompts.ts`, `src/delegation/parttimer-inject.ts`
- ワークフロー名の表示: `src/workflow/keys.ts`
- Management 画面の操作者名プレースホルダ: `web/src/pages/Management.tsx`

## 範囲外

- コードコメント (画面に出ない)。
- `src/db/schema.ts` の migration `source` (migrator が checksum に使う凍結台帳。画面に出ない)。
- 既に Discord へ投稿済みの過去メッセージ。

## 完了条件

- 上記の表示文字列から運用者名が消えている (役割が必要な箇所は「管理者」)。
- cc.acceptance.json に登録済みの対応テストが回帰しない。
- Cc の build と再起動後、新しい表示に反映されている。
