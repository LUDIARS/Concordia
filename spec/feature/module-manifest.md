---
type: feature
title: "モジュール台帳 — サービスモジュールの宣言的 manifest と ON/OFF 操作面"
description: "Concordia の機能群を Anatomia ドメイン境界に揃えたサービスモジュールとして宣言的 manifest に台帳化し、/v1/modules で mode・プロセス・health を一覧化、ON/OFF は Excubitor 代理実行に限定する。bootstrap 配線の切り出しを含む。"
service: concordia
domain: runtime-orchestration
tags:
  - lifecycle
  - process-isolation
  - excubitor
  - observability
  - config
status: planned
related:
  - interface/runtime-boundaries.md
  - feature/federation-link.md
  - setup/config-reference.md
  - plan/process-isolation-v2.md
updated: 2026-08-11
---

# モジュール台帳 — サービスモジュールの宣言的 manifest と ON/OFF 操作面

## 0. 課題と原則

プロセス分割の骨格 (backend / control-worker / chat-worker / cost-worker / workflow-worker、
`embedded` / `worker` / `off` の 3 値モード) は実装済みだが、分割単位が暗黙で、
「いま何がどのモードでどのプロセスで動いているか」を一覧する面が無い。
`bootstrap/core.ts` (約 1600 行) に配線が集中している。

原則:

- **lifecycle 権限の正本は Excubitor**。Cc は自分のモジュールプロセスを spawn / kill しない。
  ON/OFF 操作は Excubitor API の代理実行に限定し、第二の監督者を作らない。
- モジュール境界は `spec/data/anatomia-domains/` のドメイン境界に揃える。
- 設定キーの正本は `setup/config-reference.md` のまま。manifest は解決結果の宣言であり、
  新しい設定系を作らない。

## 1. manifest

`src/modules/manifest.ts` に宣言的台帳を置く。項目:

```ts
{ name, domain, mode_env, modes: ["embedded","worker","off"], entry,
  route_groups: [], tables: [], health_path, excubitor_code | null,
  degraded_note }   // off 時に何が止まり何が生きるか
```

初期台帳:

| module | mode | 現状 |
|---|---|---|
| core (sessions/control API + sweeper) | 常時 (backend) | — |
| control-jobs (taskkill/reaper) | 別プロセス固定 | 分離済 |
| chat (Discord + Slack) | embedded/worker/off | 分離済 |
| cost | embedded/worker/off | 分離済 |
| workflow (delegation queue) | embedded/worker/off | 分離済 |
| pr (queue / reconcile) | embedded/worker/off | 新規分離 |
| director (goal flow engine) | embedded/worker/off | 新設 ([director-goal-flow.md](director-goal-flow.md)) |
| messages (session_messages projector) | embedded/worker/off | 新規分離候補 |
| federation | opt-in (別ポート) | 分離済 |

## 2. API

- `GET /v1/modules` — 各モジュールの解決済み mode、担当プロセス (Excubitor code)、health、
  degraded_note を 1 コールで返す。
- 起動時検査: manifest と実配線 (mount された route group、起動した runtime) の不一致を
  error ログで fail-visible にする。無言の縮退はしない。

## 3. bootstrap 配線の切り出し

`federation/runtime.ts` の前例に倣い、`bootstrap/core.ts` から chat / cost / pr / director の
配線を各 `<module>/runtime.ts` へ移す。core.ts は manifest を走査して `runtime.start()` を
呼ぶだけにする。**挙動変更なしの機械的リファクタとして独立 PR** にし、モード別の既存
テスト (`modes.test.ts`) を維持する。

## 4. ON/OFF 操作面

- WebUI `/settings` のモジュール一覧と Discord `/co-module <name> on|off`。
- worker プロセスの起動/停止は Cc → Excubitor API (`control_service`) の代理実行。
- mode 変更 (embedded ↔ worker) は env 書換 + プロセス再起動を要するため、
  テスト交通整理 (`/v1/testing/claim`) を通し、適用は Excubitor 経由・本体フォルダのみで行う。
- off にしたモジュールの縮退動作は manifest の degraded_note を UI にそのまま表示する。

## 5. 受け入れ基準

- [ ] `GET /v1/modules` で全モジュールの mode・プロセス・health が見える。
- [ ] manifest と実配線の不一致が起動時に error ログへ出る。
- [ ] モジュール off が他モジュールを巻き込まない (dependency-cruiser にプロセス境界
      ルールを追加して静的検査する)。
- [ ] lifecycle 操作がすべて Excubitor 経由である (Cc 自身の spawn/kill 追加なし)。
- [ ] bootstrap 切り出し PR は挙動変更なしで既存テストが green。
