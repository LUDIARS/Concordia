---
type: feature
title: "セッション契約 (session contract) — 初回指示後に全作業条件を一括契約化する"
description: "model-review (spawn/task-change 時の model/effort 判定) を拡張し、モード (plan/vibes)・作業ブランチ・作業場所・スコープ・受け入れ条件の出所・goal-and-go・testing claim・上長を 1 つの型付き契約として確定する。決定論 seed → LLM 判定 → 未決フィールドは Discord 質問カードの三段。全フィールド確定まで実装着手をハーネスで封鎖する。"
service: concordia
domain: governance
tags:
  - contract
  - model-review
  - harness
  - genius
  - spawn
  - state-machine
status: planned
related:
  - feature/plan-gate.md
  - feature/vibes-mode.md
  - feature/task-workflow.md
  - feature/goal-and-go.md
  - feature/teams.md
updated: 2026-08-13
---

# セッション契約 (session contract)

> 2026-08-13 neco 指示。 spawn 時に個別に走っていた判定 (model-review の model/effort、
> delegation spawn の cwd/branch 記録、 goal-and-go opt-in の焼き込み) を 1 本の
> 「セッション契約」判定に統合する。 **LLM を使ってすべての条件を契約的に決め、
> 決められないものは Discord で決定する質問を投げる。**

## 0. 原則

1. **契約は型付きオブジェクトである。** LLM の出力は zod スキーマ検証を通った値だけが
   効力を持つ。 検証に落ちた値は採用しない (miss 扱い → 質問へ)。
2. **決め方は三段で、全フィールド共通**: 決定論 seed → LLM 判定 (Genius 照会 + 小型 judge、
   既存 model-review と同じ 1 往復) → 未決フィールドだけを束ねた Discord 質問カード 1 枚。
3. **全フィールドが確定するまで実装着手はハーネスで封鎖する** (plan-gate の封鎖述語と共用)。
4. **下流は契約だけを読む。** delegation invoke (model/effort/branch/cwd)、 ハーネス述語
   (スコープ逸脱 deny・vibes 条件付き allow)、 testing claim 自動取得、 決定論終了の判定は、
   それぞれ独自に推測せず `session_contract` を参照する。 条件の正本を 1 箇所にする。
5. Cc は LLM を内包しない原則を維持する。 judge は既存 model-review の小型 judge 経路
   (黒箱側) を使い、 Cc 本体は seed 判定・スキーマ検証・質問カードの取り次ぎだけを行う。

## 1. 契約スキーマ

セッション metadata (`sessions.metadata.contract`) に永続化。 変更はすべて
`session_events` (`kind: "contract"`) へ監査記録する。

```jsonc
{
  "version": 1,
  "mode":          "plan" | "vibes",
  "team":          "<team-id> | null",        // feature/teams.md。 チーム未導入時は null 可
  "model":         "...", "effort": "...",    // 既存 model-review を吸収
  "work_branch":   "feat/...",
  "work_location": "worktree" | "repo-root",  // vibes は repo-root (本体フォルダ) 固定
  "scope_dirs":    ["src/web/..."],           // 編集可ディレクトリ。ハーネスが enforce
  "acceptance":    "plan" | "human-ok",       // 受け入れ条件の出所 (plan md か人間の目視 OK)
  "goal_and_go":   { "enabled": true },       // 予算既定は goal-and-go spec のまま
  "testing_claim": { "required": false, "service": null },
  "supervisor":    "discord:<uid>"            // 既定 CONCORDIA_DEFAULT_SUPERVISOR
}
```

各フィールドは `{ value, decided_by: "seed"|"llm"|"human", rationale, genius_card_ids }`
を持つ (監査と再判定の根拠)。

## 2. 発火タイミング

- **spawn 時** と **初回指示投稿後** (delegation spawn は invoke prompt が初回指示に相当)。
- **task-change 時** (既存 model-review trigger を踏襲) — 契約の**更新**として同じ三段を回す。
  vibes→plan 昇格 (plan-gate §5)、 effort 変更などはすべて契約更新イベントになる。
- 人間はいつでも上書きできる: 状態カード / WebUI / `PATCH /v1/sessions/:id/contract`。

## 3. 三段判定

### 3.1 決定論 seed (LLM に聞かない)

| フィールド | seed 規則 (例) |
|---|---|
| mode | 複数リポ跨ぎ / migration・schema・認証・削除系 / 新規サービス / claim 不可 → **plan 固定** |
| team | repo からチームが一意に決まれば確定 (teams §3) |
| work_branch | 命名規則 `feat/<slug>` を機械生成 (task md slug 由来) |
| work_location | mode=vibes → repo-root、 mode=plan → worktree。 Unity 系チーム設定 → repo-root 固定 |
| supervisor | チーム設定 → config 既定 |
| testing_claim | mode=vibes → required=true + 対象サービス解決 (Excubitor catalog) |

seed で埋まったフィールドは LLM に渡さない (コンテキスト節約 + 決定論優先)。

### 3.2 LLM 判定 (契約の穴埋め)

- 既存 `ModelReviewPort` を `ContractReviewPort` に拡張する。 入力 = 初回指示 + repo 情報 +
  チーム設定、 出力 = **契約スキーマに対する構造化出力** (フィールドごとに value + rationale)。
- Genius 照会は既存経路 (spawn/task-change の判断カード参照) をそのまま使う。
- スキーマ検証に落ちたフィールド・confidence の無いフィールドは miss。

### 3.3 Discord 質問カード — plan/vibes カードは撤廃 (2026-08-21)

> 2026-08-21 neco 指示。 plan か vibes かの判断ダイアログは撤廃する。 意味が無いうえ、
> Task Workflow (委託セッション) 内で停止バグになっていた。

- **契約カード (未決フィールドの束) は投稿しない。** mode は決定論 seed が決め切り
  (§3.1)、 model / effort は LLM tier が決めなければ現 runtime を seed tier で採る。
  `ensureSessionContract` は保存前に必ず全フィールドを埋める (backstop)。
  未決が残った場合は warn ログだけ出す (封鎖はするが、 人間へ問い合わせはしない)。
- 理由: 未回答の間は契約が未確定 = §4 の `contract-incomplete` が編集を全部 deny する。
  委託セッションはカード待ちのまま何もできず、 回答内容も事実上いつも同じだった。
- 残る質問カードは**チーム選択** (`Select the team for this repository`) だけ。 回答は
  契約へ `decided_by: "human"` で反映する。
- ただしチーム選択カードも**封鎖はしない**。 候補が複数ある repo では `team` を
  `value: null` の seed で埋めて契約を成立させ、 カードの回答が来たら上書きする。
  ここを未決のまま残すと、 撤廃したはずの `contract-incomplete` 停止が複数チーム repo
  でだけ生き残る (チームは勝手に選ばない = 値は null のまま、 が両立点)。
- 単発の `mreview:` 確認ダイアログは廃止のまま。

## 4. 封鎖 (ハーネス)

- 新述語 `contract-incomplete` (**deny**): セッション契約に未決フィールドがある間、
  コードファイルの編集ツール実行を deny する (`strong-model-impl` と同型。 .md / spec /
  docs は対象外 — 契約前でも調査・設計メモは書ける)。
- suggestion: 「契約は spawn 時に決定論で確定するはずです。 未確定のままなら Cc 側の不具合として
  報告してください」。 §3.3 のとおり mode/model/effort/team はすべて決定論で埋め切るため、
  通常この deny は起きない (起きたら backstop の欠落なので Cc 側のバグとして扱う)。

## 5. API / データ差分

| 種別 | 差分 |
|---|---|
| metadata | `sessions.metadata.contract` |
| events | `session_events kind: "contract"` (確定・更新の監査) |
| API | `GET/PATCH /v1/sessions/:id/contract`、 spawn/invoke に `contract_overrides` |
| module | `src/contract/` (schema / seed-rules / review-port / question-bridge)。 `src/model-review/` は review-port 実装として吸収 |
| Discord | 契約質問カード (question.ts 基盤流用)。 `mreview:` ダイアログ撤去 |
| harness | 述語 `contract-incomplete` |

## 6. 受け入れ基準

- [ ] spawn + 初回指示で契約判定が 1 回走り、 seed で決まるフィールドは LLM に渡らない。
- [ ] LLM 出力はスキーマ検証を通った値だけが契約に載り、 検証落ちは未決になる。
- [ ] 未決フィールドが 1 枚の質問カードに束ねられ、 テキスト返信 `[A]` でも回答できる。
- [ ] 全フィールド確定まで対象セッションのコード編集が deny される。
- [ ] task-change で契約が再判定され、 変更が監査イベントに残る。
- [ ] delegation invoke の model/effort/branch/cwd が契約から読まれる (独自判定の重複が無い)。
- [ ] 人間の上書きが常に最優先で効く。
