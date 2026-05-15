# Concordia — REVIEW_MISSING_FEATURES (2026-05-13)

評価: **B-**

v0.1 scaffold は spec の F1〜F7 をひととおり実装 (sessions / events / reports / lost detect / jsonl recovery / worktree advisory / web monitor). 一方で **README に明記された機能の未着手 / stub** が複数ある.

## README/spec で約束されているが未実装
1. **Gemini CLI / Codex CLI provider 実装** (`README.md:72-75`, `spec/multi-provider.md:97-133`)
   - v0.1 stub のみと明示はされているが、 codex-cli は `tools/concordia-codex-worker.mjs` 経由のサポートが入っており (`9afbea3 feat: add codex cli worker support`), `src/providers/codex-cli.ts` も存在する. ただ Gemini は完全に未着手 (テスト無し). README で「v0.2」と書いているので OK だが、 spec/multi-provider.md:97 の調査メモが古いまま (2026-05).
2. **LLM サマリ — Anthropic SDK 経由 fallback** (`README.md:52` の F3): 現実装は claude CLI subprocess (`src/report/generator.ts`) のみ. SDK 経路の fallback (spec で「Anthropic SDK」と謳う) は無い. ANTHROPIC_API_KEY (`src/shared/config.ts:38`) が config に居るのに使われていない (`src/server.ts:196` のログでも "unused in v0.1" と書かれている).
3. **worktree 自動化の "additionalContext 注入"** (`README.md:55` の F6): `buildAdvisory` (`src/api/sessions.ts:391-406`) で `worktree_command` を返すまでで止まっており、 hook 側の AI に `additionalContext` として注入する経路は実装されていない (tools/concordia-hook.mjs を見る限り `console.log` する程度の対応). 「lock しない、 自律解決を促すだけ」という設計は守られているが、 spec で謳う「指示を注入」までは未到達.
4. **Tailscale 越え / multi-host 集約** (`README.md:139` の v0.3): scope 外と明記なので減点せず. ただ「認証なし」前提が CORS / Origin 検査も無しなので、 v0.3 着手時にここから手を入れる必要あり.

## 設計上必要だが未対応
5. **rule pruning** (`src/rules/proposer.ts:78-91`): `maxAiRules` で上限 cap はあるが、 効果の薄い AI rule を退場させる仕組みが無い. `rules.log` で fire / skip 履歴は取れるので、 「直近 24h で fire=0 の rule を auto-disable」程度の janitor が欲しい.
6. **per-session timeout / abandon の async 整合性** (`src/sweeper.ts:44-112`): runOnce 内で multiple session を逐次処理. lost が複数同時に発生したら線形にかかる. 同一 tick 内で transaction 化 (現状は repo.setStatus / appendEvent が個別 statement) しておくと crash 耐性が上がる.
7. **WS authentication / Origin check** (`src/api/ws.ts:23-56`): v0.3 で必須. 前段で Hono middleware を入れる想定でいまから interface だけ defining しておくべき.
8. **rule engine の queue (size=1)** (`src/rules/engine.ts:75-86`): 現状 busy で skip するため event-driven rule の取りこぼし発生. 1 段 queue で救えるが未実装.

## ドキュメント不足
9. **`docs/contributing-provider.md`** が `spec/multi-provider.md:178` で言及されているが存在しない (`docs/` には `codex-cli.md`, `hooks-claude-code.md`, `remote-agent-control-plan.md` のみ).
10. **README の sweep 閾値が古い**: F4 で「5 分」と書きつつ `src/shared/config.ts:33` は 1800s (30 分). 揃える.
11. **`docs/remote-agent-control-plan.md`** の存在は確認できたが README / DESIGN.md からの参照リンクが無い. spec/ ディレクトリ index が無いので発見性低い.

## "本来あった方が良い" の優先順位
1. ANTHROPIC_API_KEY fallback (#2) — config にあるのに使われていないのは中途半端
2. WS origin check (#7) — v0.3 に向けた最低限の前準備
3. README sweep 閾値修正 (#10) — 軽微だが reader misleading
4. rule pruning (#5) — proposer の自走を長期運用するなら必須
