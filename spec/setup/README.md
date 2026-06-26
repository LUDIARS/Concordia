# Concordia セットアップガイド (用途別)

Concordia は多機能サービス (loopback でのセッション協調 + Discord UI + observability + spawn 管制) なので、 「全部入りの 1 手順」 ではなく **やりたいことから引ける** ように用途別に分けてある。 まず下表で目的のガイドへ飛ぶ。

設定キーの完全な一覧と既定値は [`config-reference.md`](config-reference.md) を正本とする。 各ガイドはそこへリンクし、 キーの再掲は最小限にとどめる (DRY)。

---

## 用途別インデックス

| やりたいこと | ガイド | 主な設定軸 |
|--------------|--------|-----------|
| まず Concordia 本体を起動して session 協調を使う | [core.md](core.md) | `CONCORDIA_HOST` / `PORT` / `DB_PATH` / sweeper タイムアウト |
| **Windows** で正しく起動する (git-bash 問題等) | [windows.md](windows.md) | `CLAUDE_CODE_GIT_BASH_PATH` / port 11111 事情 |
| Discord で session を見る / 操作する | [discord.md](discord.md) | `CONCORDIA_DISCORD_*` + privileged intent |
| Slack で session を見る / 操作する | [slack.md](slack.md) | `CONCORDIA_SLACK_*` + Socket Mode + `/concordia` slash |
| サービス監視 / auto-fix (旧 Excubitor) を有効化 | [observability.md](observability.md) | `catalog/services.yaml` / `LUDIARS_ROOT` / bash path |
| 別 session を spawn する管制 / MCP 委託 | [spawn.md](spawn.md) | `.spawn.token` / `CONCORDIA_SPAWN_DEFAULT_CWD` |
| 全 env キーの正本を引く | [config-reference.md](config-reference.md) | (一覧) |

---

## 最短起動 (Claude Code + loopback)

```bash
npm install
npm run dev          # backend (11111) + Vite frontend を同時起動
```

`.env` は無くても起動する (全キーに既定値あり)。 ただし Windows では git-bash パスの設定が必要になりがちなので、 初回は [windows.md](windows.md) を先に読む。 dev 起動の background 化が許可されているのは cwd に [`dev-process.md`](../../dev-process.md) があるため (LUDIARS の dev-server policy)。

セッション協調 (hook 連携) を実際に使うには、 各 AI セッション側に hook を仕込む。 手順は [`docs/hooks-claude-code.md`](../../docs/hooks-claude-code.md) / [`docs/hooks-codex-cli.md`](../../docs/hooks-codex-cli.md)。

---

## 設定の優先順位

`src/server.ts:startBackend()` → `loadDotEnv()` → `loadConfig()` の順で解決される。

1. **プロセス環境変数** (systemd / `Start-Process` / shell export 等) — 最優先。 `loadDotEnv()` は既に `process.env` にある値を上書きしない。
2. **`.env`** (サービス cwd 直下) — `#` コメント可、 `KEY=VALUE`、 値の前後クォートは剥がす。
3. **コード上の既定値** — `config-reference.md` の「既定値」列。

`CONCORDIA_SPAWN_DEFAULT_CWD` だけは追加で「Windows かつ `E:\Document\Ars` 存在時の自動採用」 という第 2 段の既定がある ([spawn.md](spawn.md) 参照)。

---

## 関連設計ドキュメント

- [`spec/service-schema.md`](../interface/service-schema.md) — DB スキーマ / API / 用語 (session/provider/lost/transcript) の正本
- [`spec/discord-ui.md`](../feature/discord-ui.md) / [`spec/discord-control-ui.md`](../feature/discord-control-ui.md) — Discord UI 設計
- [`spec/discord-lictor-relay.md`](../feature/discord-lictor-relay.md) / [`spec/discord-session-direct-inject.md`](../feature/discord-session-direct-inject.md) — Discord ↔ session 双方向
- [`spec/delegation.md`](../feature/delegation.md) — 委託テンプレ (Codex / Claude / Gemini spawn)
- [`spec/multi-provider.md`](../feature/multi-provider.md) — provider 抽象
- [`README.md`](../../README.md) (リポ root) — サービス概要 / MCP サーバ / アーキテクチャ
