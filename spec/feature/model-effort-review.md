---
title: Genius model / effort review
status: implemented
---

# Genius model / effort review

## Scope

DiscordからのSession Spawnと、LictorがCcへ通知するtask変更を対象に、同じprovider内の
model / reasoning effortがタスクに適切かを再評価する。

## Flow (2026-08-14 契約吸収後)

model / effort 判定はセッション契約 (session-contract) の三段判定へ吸収された
(contract-absorb-model-review)。 単発の `mreview:` 確認ダイアログと spawn 前 /
task-change 後の独立経路は撤去済み。

1. `session.started` / `session.task_changed` で契約 lifecycle が走る。
2. seed tier: runtime が実際に報告した model / effort (`sessions.metadata`) があれば
   現在値として契約に載せ、 LLM tier の比較対象にする。 不明なら null (未決) のまま渡す。
3. LLM tier (`src/contract/model-review-adapter.ts`): human 決定で固定されていない model / effort を
   Genius へ問い合わせる。 miss (score閾値未満 / Genius不在) は未決に戻し、 judge へ
   フォールバックしない。 Genius hit 時だけ Cc の小型 judge が model catalog と provider 別
   effort 候補から一組を選び、 `decided_by: "llm"` として契約に記録される。
4. human tier: なお未決なら契約質問カード (1 枚) に束ねられ、 回答が
   `decided_by: "human"` で契約に載る。 human 決定は以後の再判定でも最優先で保持される
   (`preserveHumanDecisions` / `patchContractHuman`)。
5. 契約の model / effort 決定 (llm / human) が現 runtime と異なる場合、
   `src/contract/runtime-apply.ts` が Lictor `/v1/runtime/model-effort` へ反映する
   (旧 `applyRuntimeModelReview` 経路を契約側から呼ぶ)。

## Runtime switch boundary

- model / effort は英数字と `._:/-` だけからなる識別子に限定し、 改行・制御文字を含む
  human override を Lictor へ渡さない。
- Claude: Lictorが`/model <id>`、続いて`/effort <level>`を送る。
- Codex TUI: `/model`は選択UIであり、正確な非対話指定を保証できない。Lictorは409と
  再Spawn/手動選択案内を返し、catalog順を仮定したキー操作はしない。
- Codex App Server delegation: turnごとにmodel / effortを明示できるため、次turn設定として扱える。

## Source boundary

このキャッシュhit/miss制御に使うのはGeniusだけで、Anatomiaや一般HTTPキャッシュの結果は
model / effort切替条件に含めない。
