# @ludiars/blackbox — 成長型ブラックボックス 設計正本

「LLM の判断を観察して、ルールに変換して、最終的に LLM を卒業させる」汎用エンジン。
Memoria `server/blackbox/` (2026-06-09 PR #199) を共通ライブラリ化し、
**運用で一度も回らなかった学習ループを再設計**したもの。

## 0. 旧実装 (Memoria v1) の教訓

エンジンのコードは本物だったが、実運用ではルールが 1 つも育たなかった
(全ルール enabled=0 / 全判断 LLM 由来 / verdict 0 件)。原因は構造的デッドロック:

1. LLM 提案ルールは `enabled:false` で登録されるが、発火判定は enabled のみ対象
   → **候補は永遠に発火せず、レビュー対象の判断が生まれない**
2. LLM 由来の判断は `auto` でレビューキューに載らない → **人間が採点する機会が無い**
3. 有効化 API はあったが UI 導線が無い + 同一内容の提案が重複登録され続ける

v2 の設計原則: **人間のクリックが無くても学習が前進する** (LLM 自身を教師にする)。
人間の OK/NG は「加速装置 + 最終ゲート」であって、ループの必須動力にしない。

## 1. ルールのライフサイクル

```
                 影一致 ≥ shadowPromote (衝突 0)
  candidate ────────────────────────────────→ trial
      │                                         │ 人間 OK ≥ autoPromote
      │ 影衝突 ≥ shadowConflictLimit            ↓
      └────────────→ retired ←──────────────  auto
                        ↑     人間 NG ≥ autoRetract
```

- **candidate** — LLM 提案直後。発火しない。毎判断で**影評価** (§2) され、教師と
  一致し続ければ trial へ自動昇格、食い違い続ければ自動で間引かれる。
- **trial** — 発火するが毎回 `pending_review`。人間の OK/NG で信頼を積む。
- **auto** — 卒業。LLM も確認も不要で即決。NG が積めば retired へ落ちる (自己修復)。
- **retired** — 撤回。発火せず、**同一指紋の再提案はブロック**。撤回済みルールの
  一覧は LlmContext で LLM に渡し、同じ失敗の再提案自体を抑制する。

閾値は `EngineOptions` (既定: shadowPromote 3 / shadowConflictLimit 2 /
autoPromote 3 / autoRetract 3)。手動操作 (`setRuleState`) でどの状態にも動かせる。

## 2. 影評価 (shadow evaluation) — デッドロックの根本対策

`decide()` のたびに、その domain の candidate 全件を features に対して評価する:

- 条件が成立 + output が教師と一致 → `shadowAgreements++`
- 条件が成立 + output が教師と不一致 → `shadowConflicts++`
- 条件不成立 → 無シグナル (そのルールは何も主張していない)

**教師** = その判断の正解ソース。LLM フォールバックの出力、または卒業済み (auto)
ルールの出力。trial の出力は検証中なので教師にしない。
提案されたばかりのルールはその回の影評価から除外する (自己一致は自明なため)。

影評価の内訳は判断レコード (`DecisionRecord.shadow`) に永続化される。人間が LLM
判断に NG を付けたら、その判断を教師にした加点を衝突へ振り替える (**誤った教師で
育てない**)。不一致側は減点の取り消しのみで加点はしない (LLM が誤り = 候補が正しい、
とまでは言えないため)。

## 3. 重複提案のマージ

指紋 = `canonicalJson({when, output})` (キー順非依存、description は含めない)。
同一指紋の提案は行を増やさず `proposals++` + confidence は max を採る。
数値閾値が微妙に違う提案 (0.6 vs 0.65) は別ルールとして共存し、影評価が優劣を付ける。

## 4. レビューキュー

- trial ルールの発火 → `pending_review` (従来どおり)
- LLM 判断も既定で `pending_review` (旧挙動に戻すには `reviewLlmDecisions:false`)

キューは `ledger.listPending()`。UI が無い環境でも §2 により学習は前進するが、
人間の OK/NG があるほど昇格・撤回が速く正確になる。

## 5. 卒業メトリクス

`stats(domain)` → `DomainStats`: 直近 window 件の **ruleCoverage**
(ルール由来判断の割合。1.0 = LLM 完全卒業)、レビューキュー深さ、状態別ルール数。

## 6. パッケージ構成

| ファイル | 責務 | 依存 |
|---|---|---|
| `types.ts` | 中核型 + ストア境界 interface | なし |
| `condition.ts` | Condition AST の評価/検証/表示 (純関数) | なし |
| `fingerprint.ts` | 正規化 JSON / 指紋 / output 同値 (純関数) | なし |
| `lifecycle.ts` | 状態遷移の全条件 (純関数) | なし |
| `engine.ts` | decide / recordVerdict / propose / 影評価 | ストアは注入 |
| `stats.ts` | 卒業メトリクス (純関数) | なし |
| `store-memory.ts` | インメモリ実装 (テスト / ゲーム / snapshot・restore) | なし |
| `store-sqlite.ts` | SQLite 実装 + schema 保証 + v1 migration | `SqliteLike` 構造型のみ |
| `store-jsonfile.ts` | JSON ファイル実装 (CLI / ゲームサーバ、write-through)。**サブパス `@ludiars/blackbox/file` のみ** (node:fs 依存を root バレルに入れない) | node:fs |

`SqliteLike` は better-sqlite3 の `Database` と node:sqlite の `DatabaseSync` の
両方が構造的に満たす (どちらも import しない)。組み立ては
`makeSqliteBlackBox(db)` / `makeMemoryBlackBox()`。

`ensureBlackboxSchema()` は Memoria v1 テーブル (enabled 列 / state 無し) を検出して
列追加 + state 再構成 (enabled∧approvals≥3→auto / enabled→trial / rejections≥3→retired /
他→candidate) + 指紋バックフィルまで行う。冪等。

## 7. 採用マップ (LUDIARS)

| サービス | domain 例 | features → output | LLM フォールバック |
|---|---|---|---|
| Memoria (移行第1号) | `weather.will_rain` / `weather.likely_place` | アンサンブル一致率 → 雨/行き先 | runLlm |
| Quaestor | 科目コード割当 / レシート項目確定 | payee/金額帯/OCR 行特徴 → 科目・確定値 | claude-cli |
| Discutere | 議論収束判定 / 発話ゲーティング | ラウンド数・新規論点率・人間在席 → converge? | flow LLM |
| Famulus | `famulus.pick_model` | project/タスク種別 → modelId | Sonnet ワンショット (現行の曖昧時選択をそのまま LlmFallback 化) |
| ゲーム (将来) | 敵 AI / ドロップ抽選 / イベント分岐 | ゲーム状態 → 行動 | 開発時のみ LLM、出荷時は auto ルールのみ + store-memory |

利用側の実装義務: ①判断入力を FeatureMap にフラット化する関数 ②LlmFallback
(proposedRule を返すプロンプトを含む) ③レビュー UI (任意だが推奨) の 3 点。

## 8. 非ゴール

- 数値パラメータの連続最適化 (それは Quaestor `genetic.ts` = GA の領分。併存可)
- モデル蒸留 (モデルすら作らない。if 文にまで蒸留するのが本旨)
- ルール間の矛盾解決 (priority 降順の first-match のみ。複雑化しない)
