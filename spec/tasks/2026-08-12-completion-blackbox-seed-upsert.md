---
task: completion-blackbox-seed-upsert
project: Concordia
kind: 実装
created: 2026-08-12
memory_links:
  - spec/plan/harness-melpot-allowlist-design.md
---
# CompletionBlackbox のシード再投入 (insert-once の解消)

## 目的

`src/taskflow/completion-blackbox.ts:38` は fingerprint 未登録なら追加する insert-once で
シードしている。 harness gate 側で実際に踏んだのと同じ落とし穴 — `when` / `output` を
コードで書き換えると fingerprint が変わって**新ルールが増えるだけ**で、 旧ルールは `auto` の
まま発火し続ける。 既存 DB を持つ稼働環境では「コードを直したのに挙動が変わらない」。

harness gate で入れた「同 key の旧シードを retire してから現行版を投入する」upsert を
completion 側にも適用し、 再起動だけでコード側のシードが正本になる状態を揃える。

## 完了条件

- [x] `CompletionBlackbox` のシード投入を upsert 化する。 同一性キーは harness gate と同様に
      出力から導ける安定値を使い、 `when` / `output` 変更時に旧シードを `retired` にする。
- [x] 現行 fingerprint が既に存在し `auto` 以外なら `auto` へ戻す (撤回/降格からの復帰)。
- [x] 旧シード入りの DB から再シードすると新 `when` が効くこと・再シードが冪等であることを
      テストで裏取りする (`src/harness/blackbox-engine.test.ts` の「シード upsert」節と同流儀)。
- [x] 共通化できるなら upsert ロジックを 1 箇所へ寄せる (harness / taskflow で二重実装しない)。
      `@ludiars/blackbox` 側に置くか利用側ヘルパにするかは実装時に判断する。

## 備考

`RuleStore` に delete は無く `setRuleState(id, "retired")` が撤回手段 (retired は発火せず、
同一内容の再提案もブロックされる)。 共通 upsert 実装は
`src/shared/blackbox-seed-upsert.ts` を参照。

## スコープ (編集可ディレクトリ)

- `src/taskflow/`
- `src/harness/` (共通化する場合のみ)
- `src/shared/` (共通化する場合のみ)
- `lib/blackbox/` (共通化先として選ぶ場合のみ)
