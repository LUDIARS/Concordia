# Concordia — REVIEW_QUALITY (2026-05-13)

評価: **B+**

テスト 15 ファイル / vitest + tsc --noEmit lint / pino 構造化ログ / コメント密度高め — 個人プロジェクトとしては十分に上等. ただし依存と運用面で 2-3 個の不揃いが残る.

## 良い点
- **構造化ログ**: `src/shared/logger.ts` + `createChildLogger("sweeper")` などモジュール別 child logger. レベル分けされた warn / info / debug が混ざらない (`src/sweeper.ts:18-115`).
- **テスト範囲**: `tests/` に dispatcher / role-predict / chat-api / sessions-api / processes / personas-repo / rules-repo / report-generator / setup-api / codex-cli-provider / schema を網羅. v0.1 機能の主要路線は通っている.
- **コメント品質**: 各ファイル冒頭に 5-15 行の "なぜそうしたか" コメントがあり、 LUDIARS memo (feedback_*) と連動する選択 (例: claude CLI stdin で渡す理由が `src/rules/claude-runner.ts:3` に書かれている) が辿れる.
- **型定義**: `src/shared/types.ts` に集約. `ProviderName` / `SessionStatus` / `LogLevel` / `LogStream` 等が string literal union で TS strict friendly.
- **zod による request 検証** が API 全 router で一貫 (`src/api/chat.ts:12-21`, `src/api/sessions.ts:19-41`, `src/api/admin.ts:15-19`).

## ノイズ / 不揃い
1. **`safeParse` の 4 重定義** (REVIEW_IMPLEMENTATION 参照) — `src/shared/util.ts` に 1 つ集約推奨.
2. **エラー swallow の散在**: `/* swallow */` が 20 箇所以上 (`src/processes/runner.ts:71,75,122,164,...`, `src/api/ws.ts:31,38,49,...`). 各々理由はあるが、 一括 `swallow(err, "context")` でログだけ debug に出す helper があると将来の調査で助かる.
3. **commit メッセージの quality** (`git log --oneline -50`): `chore: checkpoint current work` (`9afbea3`) のような曖昧コミットが 1 件混ざっている. 個人運用としては許容範囲だが、 将来 LUDIARS 統合 CI に乗せる場合はちらつく.
4. **`concordia.db` / `concordia.db-shm` / `concordia.db-wal`** が working tree に居る (`git ls-files` 上には未表示なので gitignore は効いている). dev-process.md が紛れて tracking されているのは意図的か確認 (data や logs もリポ直下に追加されている).
5. **不要な import / unused config**: `src/shared/config.ts:38` の `anthropicApiKey` が `src/server.ts:196` のログ出力以外で参照されていない. config に居るのに動作分岐に使われない値は誤解を招く.

## テスト穴
6. **sweeper の lost→recovered パス** (`src/sweeper.ts:55-78`) のテストが見当たらない (test files に sweeper 単体テスト無し).
7. **dispatcher.onLogUpdate の round-robin / cooldown** (`src/dispatcher.ts:198-231`) のテストが `tests/dispatcher.test.ts` で確認できないなら追加推奨.
8. **rule engine の global mutex** (`src/rules/engine.ts:75-105`) の競合テストが無い.

## 命名 / マイクロ
- `LogEventKind` union (`src/dispatcher.ts:44-49`) と eventBus の event type union (`src/events.ts:7-25`) が別物. 命名が紛らわしいので `PeerLogReactKind` などに rename したい.
- `parseSessionRole` (`src/api/sessions.ts:451-457`) と `dispatcher.parseRole` (`src/dispatcher.ts:290-292`) が同義の private util. これも shared/util.ts へ.

## TS 厳格性
- `tsconfig.json` 未確認だが `lint = tsc --noEmit -p tsconfig.json` を script に持つ. CI に組み込まれていれば maintain-quality は保てる. `vitest run` も lint と並走推奨.

## 総評
コードは丁寧で、 v0.1 scaffold としては十分立ち上がっている. 重複ヘルパーと swallow の運用ルール、 sweeper / dispatcher の単体テスト追加が次の改善の主軸.
