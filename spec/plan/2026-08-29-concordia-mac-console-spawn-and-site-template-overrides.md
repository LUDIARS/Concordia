# Concordia: macOS コンソール spawn + delegation template の platform/拠点オーバーレイ設計

日付: 2026-08-29
発端: neco 指示「Mac での Cc の動きが不安定。Mac では Codex も Claude も Mac のコンソールを使用する」「delegation template を OS Platform または拠点ごとに変えられるようにしようか」

---

## Part A — macOS の対話 spawn を Terminal.app 経由にする

### 現状と問題

- Windows: `wt.exe new-tab → cmd /d /s /c <lictor> <provider>` (`buildWtArgs`, `src/control/spawner.ts`)
- macOS: `spawnDirectSession` — Lictor を **detached + stdio ignore のヘッドレス子プロセス**として直接起動し、Lictor が PTY を自前で持つ。
  コンソールが無いため (1) セッションの生死・出力が人間から見えない、(2) Cc/親環境の巻き添えで落ちても痕跡が残らない、(3) 許可プロンプト等の対話が成立しない。→「動きが不安定」の主因候補。

### 方針

darwin の対話 spawn (claude / codex / gemini = Lictor 経由の全 provider) を **Terminal.app の新規ウィンドウ**で起動する。Windows の wt.exe 経路と対称の構成にする。

### 実装

`src/control/spawner.ts` に darwin 用 builder を追加し、`spawnSession` の darwin 分岐を差し替える。

```
osascript
  -e 'on run argv'
  -e 'tell application "Terminal" to do script (item 1 of argv)'
  -e 'activate application "Terminal"'
  -e 'end run'
  -- <shellCommand>
```

- **AppleScript 文字列エスケープを持たない**: シェルコマンドは argv item として渡す (`on run argv` パターン)。インジェクション面は POSIX シェル 1 層だけになる。
- shellCommand は `cd <cwd> && env K=V… <launcher…> <provider> <args…>` を全トークン **single-quote エスケープ** (`'` → `'\''`) して結合。pure 関数 `buildMacTerminalSpawnCommand(req, launcher, envDelta)` としてユニットテスト可能にする (buildWtArgs と同格)。
- **env は「差分」を明示注入する**: Terminal.app の子は Cc の env を継承しない (login shell の env になる)。`buildSessionSpawnEnvironment` から「Cc が足す差分」を返す `buildSpawnEnvDelta(req)` を抽出し、次だけを `env K=V` で載せる:
  - `CONCORDIA_SPAWN_ID` / `CONCORDIA_SPAWN_CWD_MODE` (spawn 相関 — これが欠けると session.inject が届かない)
  - `CONCORDIA_HOST` / `CONCORDIA_PORT`
  - `sanitizeSpawnEnv(req.env)` (LICTOR_* / CONCORDIA_* / CLAUDE_CODE_DISABLE_THINKING)
  - Revisor 系 credential の削除規則は「そもそも注入しない」ので自動的に満たされる
- env の key/value にも `HEADLESS_ARG_UNSAFE_RE` 相当の fail-fast 検査を入れる (単引用エスケープで理論上安全でも、多層防御を Windows 経路と揃える)。
- **mode**: Terminal.app の `do script` は常に新規ウィンドウ。`mode:"tab"` は System Events の keystroke 送出 (アクセシビリティ権限依存で脆弱) が要るため対応しない。tab 指定は window に丸めてログに残す。
- **title**: shellCommand 先頭に `printf '\033]0;%s\007' <escaped title>;` を前置。
- launcher 解決は既存 `resolveLictorLauncher` の darwin 分岐 (`process.execPath` + dev checkout の `bin/lictor.mjs`) をそのまま使う。Terminal login shell の PATH 非依存はこの分岐が既に担保している。
- **切替キー**: `CONCORDIA_MAC_SPAWN=terminal|direct` (既定 `terminal`)。それ以外の値は fail-fast (§無言のフォールバック禁止)。direct は検証用の退路として当面残し、安定後に削除 PR。
- `codex-sdk` (Satelles) headless は当面そのまま (下の判断点 2)。

### 影響範囲

- `spec/setup/spawn.md` の「macOS は Lictor direct」記述を更新
- `spawner.test.ts` に builder の pure テスト追加 (エスケープ / env 差分 / mode 丸め)
- Lictor 側変更は不要 (PTY 所有はどちらの経路でも Lictor)

---

## Part B — delegation template の platform / 拠点オーバーレイ

### 動機

同じ `call_name` でも拠点 (Windows 本社 / Mac 拠点) で変えたい値がある:

- `default_cwd`: パス形式が根本的に違う (`C:/workspace/...` vs `/Users/example/workspace/...`) — **これが最優先の実需**
- `target_provider` / `model`: Mac では WSL codex 迂回が無い・native codex がコンソールで動く等、provider 事情が拠点で違う
- `runtime_options_json`: sandbox / runtime 指定が OS 依存
- `is_active`: 拠点でだけ無効化したいテンプレ

### 案の比較 (decision-metrics 4 軸)

| 案 | AI 学習量 | 作業コスト | 目的達成度 | 主目的との一致度 |
|----|----------|-----------|-----------|----------------|
| **1. オーバーレイ表 (推奨)** | 中 (解決順 1 本を覚えるだけ) | 中 (表 1 + 解決関数 + UI) | 高 (platform/拠点とも対応、部分上書き) | 高 (中央辞書+オーバーレイは Ludus 方針と同型) |
| 2. runtime_options_json に platform map を埋め込む | 低 | 低 | 中 (default_cwd 等 JSON 外の列を上書きできず結局列追加) | 中 |
| 3. 拠点ごとにテンプレ複製 (call_name 分岐) | 低 | 低 | 低 (call_name が拠点で割れ、呼び出し側全部に分岐が漏れる) | 低 |

**案 1 を推奨。** base (delegation_templates) は共通正本のまま、差分だけを別表に持つ。

### スキーマ

```sql
CREATE TABLE delegation_template_overrides (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL REFERENCES delegation_templates(id),
  scope_kind   TEXT NOT NULL,   -- 'platform' | 'site'
  scope_key    TEXT NOT NULL,   -- platform: 'win32'|'darwin' / site: federation の site id
  patch_json   TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(template_id, scope_kind, scope_key)
);
```

`patch_json` の許可キーは **allowlist**: `target_provider` / `model` / `default_cwd` / `runtime_options_json` / `is_active`。
`prompt_template` / `input_schema` / `call_name` は上書き不可 — プロンプトまで割れると「同じ call_name = 同じ仕事」という契約が壊れる。プロンプトを変えたい場合は別テンプレを切る。

### 解決順 (resolveTemplateForScope)

```
base → platform override (実行拠点の process.platform) → site override (実行拠点の site id)
```

- site が platform に勝つ (具体 > 一般)
- `runtime_options_json` は shallow merge、他はスカラー置換
- 解決は **invoke / spawn 時** に行い、`delegation_runs` には解決済み値を焼く (再現性)。既存の `templateToDefinition` の直後に 1 関数を挟む形で、呼び出し側の契約 (`DelegationDefinition`) は不変。

### federation との噛み合わせ

- 本社 → 拠点の `createFederationConfigSnapshot` は、**対象拠点向けに解決済みのテンプレ値**を送る (override 行そのものは送らない)。拠点侵害時に他拠点の設定が漏れない現行の最小権限方針を保つ。
- 拠点 platform は接続 handshake で拠点が申告する (protocol に `platform` を 1 フィールド追加)。
- ローカル (本社自身) の spawn は自 platform + 自 site id で同じ解決関数を通す — 経路で解決ロジックを分けない。

### UI / 運用

- Web UI (Settings → delegation templates) に「Override 追加」: scope (platform/site) と patch を編集。base 編集画面に override の有無バッジ。
- 既存テンプレは無変更で全拠点共通のまま動く (override 0 行 = 現行と 1 バイトも変わらない後方互換)。

---

## 判断点 (neco 確認)

1. **Part A の mode**: Terminal.app は新規ウィンドウのみ (tab 非対応) で許容できるか。tab が必須なら iTerm2 前提にする手はあるが依存が増える。
2. **codex-sdk (Satelles) headless の扱い**: 「Codex もコンソール」を Satelles にまで適用するか。適用するなら Satelles に PTY/コンソールモードが要り別段の改修。まずは Lictor 経由 provider のみを推奨。
3. **Part B の scope**: platform + site の 2 段で足りるか (host 単位まで割る必要は今のところ無い認識)。

## 実装順

1. Part A (spawner + spec + テスト) — Mac 不安定の即効薬
2. Part B スキーマ + 解決関数 + ローカル spawn 適用
3. Part B federation snapshot / handshake platform / Web UI

いずれも Revisor local PR、Cc は dist 実行なので反映は build + 再起動 (cc-deploy フロー)。
