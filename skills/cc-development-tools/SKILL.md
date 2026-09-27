---
name: cc-development-tools
description: Ccの共通開発ツールで作業先・Actioタスク・仕様・実装影響・検証・連携準備を扱う。定型指令を受けた時に使う。
---

# Cc 共通開発ツール

2026-09-25 neco の定型指令ツール化指示を根拠とする。頻度・損失の数値は未測定。
既存の指示範囲・開始承認を引き継ぎ、ツール結果から新しい実行権限を推定しない。

まず `concordia_tool_catalog` で現在配備されている入口と準備条件を確認する。
未接続なら Cc のサービス所有 catalog で endpoint を解決し、`GET /v1/developer-tools/catalog` を使う。
MCP が無いことと機能が無いことは別。下流 API/CLI は Cc の adapter が呼ぶ。

| 指令 | ツール |
|---|---|
| 作業用 wt を作る | concordia_create_worktree |
| ブランチを切り替える | concordia_switch_branch |
| 作業対象を登録する | concordia_bind_work |
| タスク一覧・本文・状態更新 | concordia_tasks_list / concordia_task_get / concordia_task_update |
| 明示依頼されたタスク作成 | concordia_task_create (同じ依頼は同じ request_id) |
| ガントのクリティカルパス | concordia_critical_path |
| 仕様を確認する | concordia_specifications |
| 実装箇所・影響を調べる | concordia_implementation_context / concordia_impact_analysis |
| 脆弱性を確認する | concordia_vulnerability_check |
| テスト一覧・実行・結果 | concordia_tests_list / concordia_tests_run / concordia_test_result |
| Bash を確認する | concordia_check_bash |
| 連携を確認し準備を促す | concordia_readiness |
| 変更を保存・提出する | concordia_commit_work / concordia_submit_work |
| 明示依頼されたサービス操作 | concordia_control_service |

worktree 作成・切替が返した cwd を以後の作業先にする。他者の checkout を引き取らない。
タスクは Actio reference を維持し、準備不足を別タスク起票で隠さない。
Pf/An は調査対象の正本を読む連携先であり、作業 repo をそこへ変更する指示ではない。

`readiness` が返す `next_action` を具体的な準備として示す。起動・登録・認証変更は元の指示範囲で判断し、
読取確認だけの依頼を自動設定変更へ広げない。準備不足のまま空結果を成功として返さない。

テスト実行には人間の許可根拠と request_id を渡す。受付と合格を区別し、同じ ID で結果を取得する。
通信失敗・outcome_unknown は既存の Augur run と照合する。同一 ID の内容を変えず、新規 ID で二重実行しない。
脆弱性ツールは npm lockfile の名前・版を OSV へ照会する。コード全体の安全性の証明ではない。

HTTP 代用は `POST /v1/developer-tools/execute` に
`{ session_id: 自分のLictorが返すID, input: { operation: "...", ... } }`。
session ID を推測・ログ保存しない。Bash チェックは `/v1/harness/gate` の action envelope を使い、コマンド自体は実行しない。
