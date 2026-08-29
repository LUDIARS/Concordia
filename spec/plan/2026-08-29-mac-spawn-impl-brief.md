# 実装指示書: Mac Terminal.app spawn + delegation template platform/拠点オーバーレイ

設計正本: 同ディレクトリの `2026-08-29-concordia-mac-console-spawn-and-site-template-overrides.md` を先に読むこと。
本書はそれを実装タスクへ落とした指示書。**Part A と Part B の両方をフルセットで実装する** (MVP/最小縦切り禁止。スタブ・TODO 残し禁止。完了できない項目があればスタブ化せず FAILURE として明記して止める)。

## 前提 (厳守)

- **ブランチと worktree は作成済み**。現在の task worktree とブランチ上でそのまま作業する。新ブランチを切らない。branch 切替禁止。
- push 禁止・PR 作成禁止。**コミットまで**で止める (提出は依頼元が行う)。
- 新規 npm 依存の追加禁止 (`package.json` の deps 変更禁止)。
- サービスの起動・再起動禁止。検証は typecheck + vitest のユニットテストのみ。
- Cc の vitest は shared registry (`isolate:false`) — `vi.mock` はモジュールレジストリ共有で効かないことがある。既存テストの流儀 (pure 関数を直接テスト) に合わせる。

## Part A — macOS 対話 spawn を Terminal.app 経由へ

対象: `src/control/spawner.ts` / `src/control/spawner.test.ts` / `spec/setup/spawn.md`

1. `escapePosixArg(arg: string): string` — single-quote エスケープ (`'` → `'\''`) で全体を `'...'` に包む。export して単体テスト。
2. `currentMacSpawnMode(env = process.env): "terminal" | "direct"` — `CONCORDIA_MAC_SPAWN` を読む。未設定は `terminal`。それ以外の値は throw (無言フォールバック禁止。`currentSatellesCodexRuntime` と同じ流儀)。
3. `buildSpawnEnvDelta(req, spawnId?)` — Terminal.app の子は Cc の env を継承しないため、「Cc が足す差分」だけを返す pure 関数:
   - `sanitizeSpawnEnv(req.env)` + `buildSpawnIdentityEnv(req, spawnId)` + `currentConcordiaAddressEnv()`
   - `CONCORDIA_REVISOR_WORKFLOW_TOKEN` / `CONCORDIA_REVISOR_TOKEN` は (CONCORDIA_ prefix で sanitize を通ってしまうため) 明示 delete。
4. `buildMacTerminalShellCommand(req, launcher, envDelta): string` — pure。組み立て:
   - `req.title` があれば `printf '\033]0;%s\007' <escaped title>` を先頭に
   - `req.cwd` があれば `cd <escaped cwd>`
   - envDelta があれば `env K=<escaped V> ...` を前置した `<launcher...> <provider> <args...>` (全トークン escapePosixArg)
   - 連結は `&&`
   - fail-fast 検証: env key は `/^[A-Za-z_][A-Za-z0-9_]*$/`、全トークン・値・title・cwd に `\0` `\r` `\n` を禁止 (throw)
5. `buildMacTerminalSpawnArgs(shellCommand): string[]` — osascript の argv:
   `["-e","on run argv","-e","tell application \"Terminal\" to do script (item 1 of argv)","-e","tell application \"Terminal\" to activate","-e","end run", shellCommand]`
   AppleScript 文字列へシェルコマンドを埋め込まない (argv 渡しでエスケープ層を持たない) のが要点。
6. `spawnMacTerminalSession(req): SpawnResult` — 上記で組み立てて `spawn("osascript", args, { detached: true, stdio: "ignore" })`。エラーハンドリングは `spawnDirectSession` と同型 (try/catch + `child.on("error")` + `reportError` + `unref`)。`command` は診断用の固定 AppleScript 部分だけを返し、環境値を含む末尾の shell command は redacted 表示にする。
7. `spawnSession` の darwin 分岐: `currentMacSpawnMode()` が `direct` なら従来 `spawnDirectSession`、`terminal` (既定) なら `spawnMacTerminalSession`。mode 読み取りの throw は `{ ok:false, error }` に変換。
8. `mode: "tab"` は Terminal.app では新規ウィンドウに丸める (do script は常に新規ウィンドウ)。コメントで明記。
9. ファイル先頭の doc コメントと `spec/setup/spawn.md` の「macOS は Lictor direct」記述を更新 (CONCORDIA_MAC_SPAWN キーも設定キー表へ追記)。
10. テスト (`spawner.test.ts` に追記): escapePosixArg (単引用符入り・空文字)、currentMacSpawnMode (既定/direct/不正値 throw)、buildSpawnEnvDelta (spawn id/cwd mode/address が入る・Revisor token が落ちる・allowlist 外が落ちる)、buildMacTerminalShellCommand (cd/env/printf の合成・不正 env key throw・改行入り引数 throw)、buildMacTerminalSpawnArgs (argv 構造)。

## Part B — delegation template の platform / 拠点オーバーレイ

対象: `src/db/schema.ts` / `src/db/delegation-repo.ts` / `src/delegation/` 新規 / `src/api/delegation.ts` / `src/federation/` / Web UI (Settings の delegation templates 画面) / `spec/feature/delegation.md`

1. スキーマ (`schema.ts`): 設計書どおり `delegation_template_overrides` 表 + `UNIQUE(template_id, scope_kind, scope_key)` + active index。既存 migration の流儀 (CREATE TABLE IF NOT EXISTS 追記) に合わせる。
2. `delegation-repo.ts`: `DelegationTemplateOverrideRow` 型 + CRUD (`listTemplateOverrides(templateId?)` / `upsertTemplateOverride` / `deleteTemplateOverride`)。`scope_kind` は `'platform' | 'site'` のみ受理、`scope_key` は platform のとき `win32|darwin` のみ受理 (それ以外 throw)。
3. 新規 `src/delegation/template-overrides.ts` (pure):
   - `TEMPLATE_OVERRIDE_PATCH_KEYS = ["target_provider","model","default_cwd","runtime_options_json","is_active"]` — patch_json はこの allowlist のみ。未知キーは throw (無言で捨てない)。
   - `resolveTemplateForScope(base: DelegationTemplateRow, overrides: DelegationTemplateOverrideRow[], scope: { platform: NodeJS.Platform; siteId: string | null }): DelegationTemplateRow`
   - 解決順 base → platform → site (site が勝つ)。`runtime_options_json` は JSON parse して shallow merge、他はスカラー置換。`is_active` が false に解決されたテンプレは invoke 側で「無効テンプレ」と同じ扱い。
   - 単体テスト必須 (置換・merge・優先順位・allowlist violation throw・override 0 行 = base 完全一致)。
4. 配線: invoke / spawn 経路で `templateToDefinition` を呼んでいる箇所 (grep で全列挙すること) の直前に解決を挟む。ローカル解決 scope は `process.platform` + 自 site id (拠点として動作している場合。`src/federation/env.ts` / runtime を調べて取得。拠点でなければ null)。`delegation_runs` へは解決済み値が焼かれること (既存の焼き込みが rendered 値を使っていればそのままで満たされる — 確認して PR 説明に書く)。
5. federation:
   - `src/federation/protocol.ts`: 拠点 handshake に `platform` フィールドを追加 (拠点が自 platform を申告、本社が保持)。後方互換: 未申告は override 解決で platform scope をスキップ。
   - `src/federation/config-snapshot.ts`: `createFederationConfigSnapshot` に対象拠点の `{ siteId, platform }` を渡し、templates を**解決済み値**で送る。override 行そのものは snapshot に含めない (最小権限方針維持)。
   - 既存テスト (`config-snapshot.test.ts` / `protocol.test.ts`) を更新し、per-site 解決のテストを追加。
6. API (`src/api/delegation.ts` の既存 template CRUD の流儀に合わせる): overrides の list / upsert / delete エンドポイント (loopback admin)。入力検証は repo 層の throw を 400 に変換。
7. Web UI: Settings の delegation template 編集画面に override の一覧 + 追加/編集/削除 (scope_kind, scope_key, patch フィールド)。既存 UI の実装場所と流儀を調べてそれに合わせる (新フレームワーク導入禁止)。大掛かりな装飾は不要だが動くこと。
8. `spec/feature/delegation.md` に override 節を追記 (解決順・allowlist・federation の解決済み配布)。

## 完了条件 (machine-checkable — 結果を最終コミットメッセージ本文か PR 説明用の VERIFICATION 節として `spec/plan/2026-08-29-mac-spawn-impl-verification.md` に書く)

- [ ] `npm run typecheck` (無ければ `npx tsc --noEmit`) が pass
- [ ] `npx vitest run src/control/spawner.test.ts src/delegation/template-overrides.test.ts src/federation/config-snapshot.test.ts src/federation/protocol.test.ts` が pass (既存 fail があれば元から fail かを main で確認し報告)
- [ ] `grep -n "CONCORDIA_MAC_SPAWN" src/control/spawner.ts spec/setup/spawn.md` がヒット
- [ ] `grep -rn "delegation_template_overrides" src/db src/api src/delegation src/federation` がヒット
- [ ] `git diff main --stat` に package.json / package-lock.json が**含まれない**
- [ ] 全変更をコミット済み (未コミット差分 0)

## アンチパターン (禁止)

- 「それっぽい偽完成」: 未配線の関数だけ置く / UI をプレースホルダにする / テストを skip にする
- スコープ外の修正 (既存バグを見つけたら直さず VERIFICATION に記載のみ)
- 検証と称したサービス起動・DB 実書き込み (schema 追加は CREATE TABLE 文のコード追加であり、実 DB へ手で流さない)
