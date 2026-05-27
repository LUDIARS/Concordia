# 設計レビュー (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 142538d (2026-05-25) |
| 対象コミット範囲 | 013a922 〜 142538d (31 commits) |

## 1. 設計強度 (A)

| 観点 | 所見 |
|------|------|
| 障害分離 | session → repo → host の 3 階層インデックス。single sqlite SPOF は WAL + backup 戦略で軽減。lost session の jsonl recovery 経路あり |
| 冪等性 | `session_task_records` upsert (`UNIQUE(session_id, task_text)`)、token 再生成は valid なら返却、event 重複は IGNORE |
| 入力バリデーション | Zod schema 全 API endpoint 適用、regex compile 失敗は warn ログで graceful degrade |
| エラーハンドリング | parse failure → 400, internal error → 500、exception stack は response に含めない |
| リトライ・タイムアウト | stat-scheduler 10 分 poll + 5 分 idle trigger、rule engine cooldown+mutex、sweeper 1 分周期、claude-runner timeout は env configurable (default 120s) |
| 状態管理 | sessions.status enum (active/ended/lost/abandoned) で一意、task_records は completed_at フリーズで履歴保護 |

## 2. 設計思想の一貫性 (A)

- レイヤー: API → Repo → DB → Schema が単方向
- 命名: ファイル kebab-case / schema snake_case / TS code camelCase で統一
- Provider abstraction (`src/providers/*`) で claude / gemini / codex / unknown を統一インタフェース化
- 設定外出: `.spawn.token` / `CONCORDIA_SPAWN_DEFAULT_CWD` 等の env 取り回し
- 5/25 の hook session_id 解決優先化 (142538d) も「明示 ID > metadata > heuristic」の既存方針に一致

## 3. モジュール分割度 (A)

| モジュール | 凝集度 | 所見 |
| --- | --- | --- |
| `src/api/*.ts` | 機能的 | 各 endpoint 単一責務 |
| `src/db/*.ts` | 機能的 | Repo クラスが CRUD 専任、トランザクションは内封 |
| `src/control/*.ts` | 機能的 | lictor-proxy / spawner / token (auth) 分立 |
| `src/rules/*.ts` | 機能的 | engine / handler / proposer / prompt-builder 関心分離 |
| `src/stat/*.ts` | 機能的 | scheduler / repo-change-watcher / processor 独立 |

循環依存なし (tsc --noEmit 確認可)。

## 重大指摘

なし (Design 3 観点とも A)。
