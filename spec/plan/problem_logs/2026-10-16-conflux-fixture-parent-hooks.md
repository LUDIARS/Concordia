# Conflux fixture への親 Git hook 設定混入

- Date: 2026-10-16
- Status: fixed in working tree（実行検証待ち）
- Area: harness-reliability / disposable Conflux Git fixture

## Summary

Actio `actio:54ea56ed-94b4-4206-bf5f-da00be1b2ed9` に、前日の実Gitテストで親由来hookが動き、審査の遅延と再試行が生じたと記録されている。生ログや正確な発生時刻は未提供。

## Evidence / Cause

`tests/harness-reliability/conflux.test.ts` はlocalのcore.hooksPathだけを設定していた。親のGIT_CONFIG_COUNT/KEY_n/VALUE_nがlocal設定に優先し、adapter経由のswitchも親環境を継承する。これは依頼本文とコードの照合結果であり、本セッションで再現実行はしていない。

## Fix Requirements / Verification

全Git呼び出しへfixture専用のcommand scope設定を渡す。process.env、実リポの設定、session harnessのhook権限は変更しない。既存helper探索では適合するものが見つからず、fixture内だけの引数生成を追加する。

Augur planは再現回帰テストと狭い修正を推奨。sentinel hookの実行可能性、commit/worktree/switch後の未実行、親環境保持を回帰テストで確認する。依頼に従い実行はRevisor担当。git diff --check等の静的確認のみ本セッションで行う。

## Follow-up

Revisorの検証結果を確認する。本体mainへの編集禁止が明示されているため、この記録も指定worktree内に置く。
