# codex-sdk 状態カードのコスト計測

## 目的

Discord 状態カードが `codex-sdk` セッションの `codex_usage` transcript frame を読み、未計測ではなく使用量を表示できるようにする。

## 作業

1. state-machine の `State$` call-edge 規約に適合するよう、read model 内の relay 投影を明示依存のモジュール関数へ分離する。
2. `TranscriptLogsRepo.listUsagePayloads` を read model に配線し、状態カードのコスト算出へ渡す。
3. codex-sdk usage frame が状態カードのコスト badge に反映されることをテストする。

## 完了条件

- `npm run lint` と `npm test` が通る。
- Anatomia PR review の changed error violation が 0 件。
