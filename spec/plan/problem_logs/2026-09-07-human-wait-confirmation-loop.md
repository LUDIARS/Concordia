# 人間待ち中の確認・残作業分解ループ

- Date: 2026-09-07
- Area: Taskflow residual / phase-compaction / stalled-session-nudge

## Evidence

同じセッションで PR 1457・1458 完了後に residual-sweep が繰り返され、AIが「タスク無し」と
答えた後も人間待ち確認が続くことを neco が指摘した。
`checkResidual` は pending/delegated task がない限り毎回分解を注入し、
`TaskflowRuntime` は final_answer を次の完了判定の契機にする。
`isUnansweredNudge` は assistant/tool 出力を反応ありとみなし、人間の応答とは区別していなかった。

## Regression Context

従来の「無反応なら再確認しない」方針が、AIの返答で解除される経路による再発。
実行テストによる再現は行わず、ユーザー通知とソースから経路を特定した。

## Fix Requirements

確認後の人間待ちをセッション metadata に保存し、人間由来のイベントだけで解除する。
抑止時には residual-sweep の付随注入も止め、終了可否とは分離する。

## Verification

同時確認、AIのみの返答、再起動、人間の回答、未回答カード、既知タスクの自走を確認対象にする。
テストとサービス操作は明示指示がないため実行しない。

実装後、backend と test-source の `tsc --noEmit` は通過した。回帰ケースをコードに追加し、
差分・ドメイン所属・文書参照を静的に確認した。実行テスト・再起動・稼働サービスへの反映は未実施。
