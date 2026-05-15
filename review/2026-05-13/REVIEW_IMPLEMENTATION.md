# Concordia — REVIEW_IMPLEMENTATION (2026-05-13)

評価: **B+**

TypeScript strict + Hono + better-sqlite3 という素直なスタック. dispatcher / sweeper / rule-engine の core ロジックは凝集度が高い. 一方で同一パターン (`safeParse`, `nowSec()`, `parseMeta`) の散在や、 dispatcher の `onChatPosted` が DELETE /v1/sessions/:id 側で **手動再emit** している二重実装が散見される.

## 良い点
- `src/sweeper.ts:36-112` は active→lost→abandoned→purge の遷移を 1 関数で読み下せる. event purge + task purge も同 tick で行う作りが綺麗.
- `src/processes/runner.ts:80-208` は Windows の cmd → npm → node tree を taskkill `/T /F` で殺す回避策 (`src/processes/runner.ts:191-198`) が明示コメント込みで実装. LUDIARS memo の Windows ノウハウが活きている.
- `src/rules/claude-runner.ts:34-45` の Git for Windows bash 自動検出は memo `feedback_claude_cli_windows_bash` と整合.

## 重複 / 散在
1. **`safeParse` / `parseMeta` / `nowSec` が複数ファイルで再定義** — `src/dispatcher.ts:305-312`, `src/api/sessions.ts:425-456`, `src/api/personas.ts:20-24`, `src/api/chat.ts:140-142`. `src/shared/` に集約推奨.
2. **chat post の二重発火**: `src/api/sessions.ts:336-353` で DELETE 時に手動 insert + `dispatcher.onChatPosted` + `eventBus.emit("chat.posted")` を実行している. `src/api/chat.ts:39-69` と同じシーケンスなので、 共通関数 `postChat(deps, input)` に切り出すべき. 片方更新時の bug の温床.

## 細部の品質
- **30 秒同期処理 in HTTP handler** (`src/api/sessions.ts:325-330` の `generateReport`): claude CLI を 30s timeout で待たせる. 想定 client は hook なので catch されるが、 UI から DELETE する場合は freeze する. `await` を外して `setImmediate` + report が出来たら eventBus で通知が望ましい.
- **rule engine の "global mutex"** (`src/rules/engine.ts:75-105`): `running` フラグ 1 つで全 rule をシリアル化. 妥当な選択だが、 tick rule が多数登録された時に互いに遅延する. log に skip が量産されている可能性があり、 ログレベル `debug` の値はあるが、 `rules.log` (DB) への永続化は重い (`src/rules/engine.ts:78`).
- **engine と proposer の prompt builder 重複** (`src/rules/engine.ts:107-148` + `src/rules/proposer.ts:122-138`) — 出力 schema は同じ AddRule/Skip/Post/Remove. proposer が直接 `handleAction(.., "_proposer", json)` を呼んでいる (`src/rules/proposer.ts:164`) ので、 `post` action を返した時の挙動が unspecified (description には add_rule/skip のみと書いてあるが handler は post も受理する). proposer 側で allow-list filter は実装済 (`src/rules/proposer.ts:154-162`) なので OK だが、 spec とコードの整合性をコメントで明示すべき.
- **`extractJson()`** (`src/rules/claude-runner.ts:128-145`) は 3 段 fallback で堅い. proposer 側 `parseJson()` (`src/rules/proposer.ts:190-197`) と重複しているので統合可能.

## 軽微
- `src/dispatcher.ts:298-299` の `countWorkEvents` は O(n) で問題ないが、 hot path. `recentEvents(session.id, 30)` で取って毎 event 評価しているので、 events 多数 session で sweeper 待ち時間が読めない. session_id index ある (`src/db/schema.ts:44`) ので問題ない範囲だが、 計測しておきたい.
- `src/role/predict.ts:84-126` のスコアリングは 8 ロール × 各 match function. 線形 + 単純加重なので可読性高い. ただ `c.toolCalls.lint` (`src/role/predict.ts:60`) など lowercase 固定で、 hook 送信側が `Bash` / `Lint` 等を混在で送ると当たらない. spec で tool 名の正規化を定義した方が良い.
- `src/api/ws.ts:42-50` の ping は alive flag 1 個でフェイルクローズ. round-trip 1 回失敗で terminate なので長い GC pause 中の正常 client を切る可能性. `missedPings` counter にしておくと丁寧.
