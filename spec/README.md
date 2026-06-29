# Concordia 仕様書

複数 AI エージェント（Claude Code / Gemini / Codex）のセッション協調・記録・管制を
行う **Concordia** の仕様。AIFormat
[`FORMAT_SPEC.md`](https://github.com/LUDIARS/AIFormat/blob/main/FORMAT_SPEC.md)
の 6 分類に整理する。

## 構成
```
spec/
├── data/        # SQLite スキーマ一覧（schema.ts 正本）
├── feature/     # 機能（Discord 連携 / 委託 / multi-provider）
├── interface/   # API・schema 正本（service-schema.md）
├── setup/       # 起動・設定（用途別ガイド + hook 連携手順）
└── test/        # テスト設計
```
> `plan/` は未設置（ロードマップは README §開発ステータス）。

## feature 一覧
| ドキュメント | 概要 |
|---|---|
| [discord-ui.md](feature/discord-ui.md) | Discord UI 基本 |
| [discord-ui-pr-b.md](feature/discord-ui-pr-b.md) | Discord UI PR-B |
| [discord-control-ui.md](feature/discord-control-ui.md) | Discord 制御 UI |
| [discord-lictor-relay.md](feature/discord-lictor-relay.md) | Discord ↔ session 双方向リレー（Lictor 仲介） |
| [discord-session-direct-inject.md](feature/discord-session-direct-inject.md) | Discord からセッションへ直接注入 |
| [delegation.md](feature/delegation.md) | エージェント間タスク委託テンプレ |
| [multi-provider.md](feature/multi-provider.md) | Provider 抽象（Claude/Gemini/Codex） |

## interface
- [service-schema.md](interface/service-schema.md) — DB schema / REST・WS・MCP API の正本。
  データの詳細リストは [data/schema.md](data/schema.md)。

## setup
- [setup/README.md](setup/README.md) — 用途別セットアップ（core / windows / discord /
  observability / spawn / config-reference）。
