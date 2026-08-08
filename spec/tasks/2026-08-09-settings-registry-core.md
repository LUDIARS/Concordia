---
task: settings-registry-core
project: Concordia
kind: 実装
status: pending
created: 2026-08-09
source_session: lictor-cda8a337-d0f2-47ee-aa8a-639329b9fd55
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/setup/config-reference.md
---
# 設定項目レジストリを 1 箇所に作る (W5-1)

## 目的

設定の一部が DB / env にしか無く WebUI から見えない。 変えるには DB や env を直接触るしかない。
`src/discord/conn-config.ts` が持つ `source` (`db|env|default|none`) の考え方をシステム全体へ広げ、
「どんな設定項目が存在し、 今の値がどこ由来か」 を 1 箇所で答えられるレジストリを作る。

W5-2 (API) / W5-3 (WebUI) / W5-4 (カバレッジテスト) はすべてこのレジストリを読む。
このタスクが他 3 つの前提。

## 完了条件

- 設定項目 1 件が以下を持つ型として定義されている:
  `key` / `label` / 型 / 既定値 / env 名 / 現在値 / 出所 (`db|env|default|none`) / 説明 / 所属セクション。
- 現在値と出所を解決する関数があり、 DB (`schema_meta` / AdminState) → env → 既定 の
  優先順を 1 箇所で表現している。 どこにも無ければ `none` を返す。
- secret 系項目は 「値を持たない」 ことを型で表現している (W5-2 が API で誤って値を返せない形)。
- `spec/setup/config-reference.md` に載っている env キーがレジストリ定義から辿れる。
- 項目定義を**後から足せる**構造になっている
  (並行 PR がワークフロー有効化フラグ `workflow.task` 等を後から追加する。 自分では追加しない)。

## スコープ (編集可ディレクトリ)

- `src/config/` (新規レジストリ。 env 読み出しの正本は既にここ)
- `src/db/` (既存 `schema_meta` 読み出しの再利用のみ。 スキーマ変更は伴わない想定)
- `spec/tasks/` (この md)

## 触らないもの (並行 PR の領域)

- `src/discord/bot.ts` の設定解決 (起動時スナップショット → 都度解決は別 PR = W6)
- ワークフロー有効化フラグの追加そのもの (別 PR)
- RWF のアクション追加と Discord UI (別 PR)

`src/discord/conn-config.ts` は**参照するだけ**で既存ロジックを変更しない。

## 設計上の注意

- SRP を守り、 レジストリ定義 / 出所解決 / 型 を 1 ファイルに詰め込まない。
- 無言フォールバック禁止 (RULE_CODE §7.1)。 出所が特定できない項目は `none` を明示し、
  「既定値らしきもの」 を勝手に捏造しない。
