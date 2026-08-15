# Satelles codex-sdk spawn への WSL runtime 配線

## 目的

Windows 版 codex CLI は `CreateProcessWithLogonW` 経由の `CodexSandboxOffline` 起動で
lsass ログオンセッションをリークする既知の未修正バグ (upstream #33356 / #35940) を
持つ。Satelles (codex-sdk headless runner) は既に `SATELLES_CODEX_RUNTIME=wsl` で
WSL 内 Linux codex を起動する回避策を実装済み (Satelles PR#579 マージ済) だが、
Concordia の delegation 経由 spawn には runtime 切り替えの配線が無く、Satelles の
既定 (`native`) から動かせない。Concordia 側に runtime 設定を追加し、`codex-sdk`
provider の headless spawn 時だけ Satelles へ WSL 起動情報を渡せるようにする。

## 作業

1. `src/config/settings/definitions/session.ts` の `SESSION_SETTINGS` に
   `session.satelles_codex_runtime` (`CONCORDIA_SATELLES_CODEX_RUNTIME`, 既定
   `"native"`)・`session.satelles_wsl_distro` (`CONCORDIA_SATELLES_WSL_DISTRO`, 既定
   `"Ubuntu"`)・`session.satelles_wsl_user` (`CONCORDIA_SATELLES_WSL_USER`, 既定
   `"ubuntu"`)・`session.satelles_wsl_codex_binary`
   (`CONCORDIA_SATELLES_WSL_CODEX_BINARY`, 既定 `"codex"`) を `satelles_launcher` と
   同じ書式 (`editable: false`, env のみ) で追加する。
2. `src/control/spawner.ts` に env 直読みの resolver
   (`currentSatellesCodexRuntime` / `currentSatellesWslDistro` /
   `currentSatellesWslUser` / `currentSatellesWslCodexBinary`) を追加する。
   `CONCORDIA_SATELLES_CODEX_RUNTIME` が `native` / `wsl` 以外の値なら例外を投げて
   fail-fast する (無言のフォールバック禁止)。distro / user / codex binary は
   `HEADLESS_ARG_UNSAFE_RE` と同じ危険文字集合で検証し、不正なら例外を投げる。
3. `buildSessionSpawnEnvironment()` で `req.provider === "codex-sdk"` かつ
   runtime が `"wsl"` のときだけ、子 env に `SATELLES_CODEX_RUNTIME=wsl` /
   `SATELLES_WSL_DISTRO` / `SATELLES_WSL_USER` / `SATELLES_WSL_CODEX_BINARY` を
   明示注入する。runtime 既定 (`"native"`) のときや `codex-sdk` 以外の provider
   では一切注入しない (完全後方互換)。
4. `src/control/spawner.test.ts` に単体テストを追加する: runtime 既定で
   `SATELLES_*` が子 env に現れないこと、`wsl` 指定時に 4 変数が入ること、
   `codex-sdk` 以外の provider (`claude` 等) には注入されないこと、不正な
   runtime 値・不正な distro/user 値で resolver が例外を投げること。

## 完了条件

- `session.satelles_codex_runtime` 系 4 設定が `SESSION_SETTINGS` に定義されている。
- `buildSessionSpawnEnvironment()` が `codex-sdk` provider かつ `runtime=wsl` の
  ときだけ `SATELLES_CODEX_RUNTIME` / `SATELLES_WSL_DISTRO` / `SATELLES_WSL_USER` /
  `SATELLES_WSL_CODEX_BINARY` を子 env に注入し、それ以外では 1 バイトも既存の
  spawn env を変えない。
- 不正な runtime / distro / user / codex binary 値は spawn 前に例外で弾かれる。
- `src/control/spawner.test.ts` に上記の回帰テストが追加されている。
