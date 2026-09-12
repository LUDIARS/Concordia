# Git hook 再入ガード

## 目的

Cc の一時 hook wrapper が Revisor の managed hook 経由で再入したとき、元のグローバル hook へ安全に委譲し、設定配列の不整合で Git 操作を失敗させない。

## 完了条件

- `CONCORDIA_SESSION_HOOK_DEPTH` を wrapper 起動ごとに加算し、2 周目は環境復元を行わない。
- グローバル `core.hooksPath`（未設定時は `~/.git-hooks`）の同名 hook が実行可能なら、stdin・引数を保持して直接実行し、その終了コードを返す。
- 実行可能な元 hook が無い再入は成功として終了し、再入先候補を stderr に 1 行記録する。
- Vitest fixture が通常、グローバル hook あり、グローバル hook なしを実 Git なしで検証する。

## ドメインと不変条件

- 価値 ID: UX-CC-W1 / UX-CC-W5
- シナリオ: managed hook が Cc wrapper に戻っても、グローバルに所有された元 hook を一度だけ実行して Git 操作を完了する。
- 状態所有者: session-coordination domain が session hook wrapper と注入環境を所有する。
- 不変条件: C-8 resolveReentryHook(input): 再入時はグローバル hooksPath 内の同名で実行可能な hook だけを選ぶ。
