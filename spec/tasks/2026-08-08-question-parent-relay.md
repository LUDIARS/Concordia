---
title: "委託子 Question の親セッションリレー"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-08-08
---

# 委託子 Question の親セッションリレー

TaskWorkflow の委託中に子セッションが Question (AskUserQuestion / ask) を発行すると
「主人のいない Question」になる問題の根治 (2026-08-08 neco 指示)。

## 現行の欠落 (transcript 経路との非対称)

- `question.posted` は子セッション面にしか届かず、 面が無ければ無言破棄
  (`src/discord/question.ts` の `findBySessionId` → return)。
- transcript には「子が非アクティブなら親面へ振替」フォールバックがある
  (`src/discord/egress.ts`) のに question 経路には無かった。
- メンション解決 (`lastHumanRequester`) は委託子の inject source
  (`delegation:<run>:parent`) を人間として解決できず、 無メンションカードになる。
- persona-context は「親に聞け」と指示するが、 子→親の質問経路は実装されていなかった。

## 実装

1. **親解決**: `DelegationRepo.findRunByChildSession` で質問発行時に run を引き、
   `question.posted` に `parent_session_id` / `delegation_run_id` を載せる。
2. **親セッションへのリレー inject**: 質問本文 + 選択肢 + 回答手順
   (`POST /v1/sessions/<child>/answer-question`) を親へ inject
   (`buildDelegationQuestionRelayText`)。 親 (委託元) が自分で回答するか、
   ask で人間へ引き継ぐ。
3. **Discord 面フォールバック**: 子の面が無い/非アクティブなら親の面へカードを投稿。
   投稿チャンネルを `discord_pending_questions.discord_channel_id` に永続し、
   解決 (ボタン除去) は保存済みチャンネルで辿る。
4. **メンション解決のフォールバック**: 子の履歴で人間が解決できなければ親の履歴から
   `lastHumanRequester` を再解決する。

## Non-goals

- Slack 側の面フォールバック (Discord 優先。 Slack は provisioner.ensure が面を作るため
  無言破棄は起きにくい)
- taskflow overview / WebUI の親子可視化 (別 PR)
