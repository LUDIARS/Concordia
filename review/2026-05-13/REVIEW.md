# Concordia — Review Summary (2026-05-13)

LUDIARS 自動コードレビュー (AIFormat §5 準拠). 対象 ref は `d7e829f` (HEAD, `feat: add codex cli worker support`).

| カテゴリ | 評価 | 主要所見 |
|---------|------|---------|
| Design          | A- | spec / src の責務分離と Concordia 名通りの "lock しない調停" が明確. 一方 README:53 の lost 5 分と config 30 分が不整合, provider 中立を謳いつつ recovery 経路は claude-code 前提. |
| Vulnerability   | B  | loopback 認証なし前提で多くは許容圏内. 例外として `POST /v1/processes` の任意 shell 起動 + WS Origin 未検証 + rule_proposer/handler の prompt-injection 経路は v0.3 Tailscale 越え前に対処が必要. |
| Implementation  | B+ | 凝集度の高い core. `safeParse` / `parseMeta` / `nowSec()` の重複, DELETE /sessions/:id の同期 30s LLM 呼び出し, rule engine の global mutex の取りこぼしリスク. |
| Missing Features| B- | F1〜F7 は v0.1 範囲で揃う. ただし anthropicApiKey が config だけにあり SDK fallback 未配線, worktree additionalContext 注入未到達, Gemini provider 完全 stub, `docs/contributing-provider.md` 不在. |
| Quality         | B+ | テスト 15 + pino + zod + 詳細コメント. swallow 20+ 箇所の helper 化, sweeper 単体テスト追加, `anthropicApiKey` unused の整理が望ましい. |

## Weighted score
- Design 25% × A- (90) + Vulnerability 20% × B (80) + Implementation 20% × B+ (85) + Missing 15% × B- (78) + Quality 20% × B+ (85) = **83.7 / 100**

## トップ 5 アクションアイテム (優先順)
1. **`POST /v1/processes` の command を allow-list 化 or Origin/CSRF 検証** — `src/api/processes.ts:52-68` + `src/processes/runner.ts:80-86`
2. **README の lost / sweep 閾値を 1800s に整合** — `README.md:53` ↔ `src/shared/config.ts:33`
3. **WS の Origin / loopback peer 確認 guard** — `src/api/ws.ts:23-56` (v0.3 Tailscale 越えの前提整備)
4. **`safeParse` / `parseMeta` / `nowSec` を `src/shared/util.ts` に集約** — `src/dispatcher.ts:305`, `src/api/sessions.ts:425`, `src/api/personas.ts:20`, `src/api/chat.ts:140`
5. **`anthropicApiKey` を unused のまま放置せず, claude CLI 失敗時の SDK fallback もしくは config から削除** — `src/shared/config.ts:38`, `src/server.ts:196`, `src/report/generator.ts`
