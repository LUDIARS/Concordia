---
task: 2026-10-23-consult-attachments
project: Concordia
kind: 実装
created: 2026-10-23
memory_links: []
---
# 相談部屋の添付を相談の AI へ届ける

## 依頼 (2026-10-23 neco)

- 「添付が相談部屋の場合はなぜか届かない (ふつうの AI セッションは届く)」
- 方針: 推奨案で進める (同日回答)。「添付は全部見れるはずだから見れるようにしてほしい」
- 同じ依頼の他 2 件 (Concordia 外):
  - 企画相談のメンションは最初の 1 回だけ → 相談フォルダ `_source/memory/MEMORY.md` を直して sync 済み (相談フォルダのリポ、未コミット)
  - Notion / Drive の公開リンクが読めない → 相談フォルダの取得コマンドを Canalis で信頼ドメインのクロール + 更新時刻キャッシュにする
    (委託 run ad8ffc15-6623-486c-8aac-f6804d302b58、相談フォルダのリポ)

## 目的

相談部屋に添付された画像・PDF・文書・表・テキストを、相談の AI が中身を見て答えられるようにする。

## 対象・変更内容

仕様: `spec/feature/tech-consultation.md` §6.6 (SPEC-CONSULT-ATTACHMENTS)、CC-CONSULT-INV-12。

- `src/discord/attachment-inbox.ts` (新規): 画像以外の添付の保存と指示文
- `src/discord/ingress.ts`: 画像以外の添付を受け取る (空の投稿として捨てない)。相談部屋は相談者ごとの置き場所へ保存
- `src/consultation/consult-attachments.ts` (新規): 置き場所・パス判定・Claude の権限規則
- `src/consultation/safety-policy.ts` / `safety-service.ts` / `safety-runtime.ts`: Read / view_image を置き場所の中だけ通す
- `src/consultation/projectless-consult.ts` / `consult-fetch-link.ts` / `projectless-consult-launch.ts`、`src/control/budget-resume-launch.ts`:
  claude に Read を足し、置き場所だけ許可・相談フォルダの Read を拒否
- `tools/consult-codex-hook.mjs`: view_image の対象パスを Cc の判定へ渡す
- `src/discord/bot.ts` / `src/api/register-core.ts`: 配線

## 受入条件

- 画像以外の添付だけの投稿が、相談部屋 (と通常のセッション) で保存先のパス付きでセッションへ届く。保存できなければ理由を返信する
- 相談セッションは自分の相談者の添付の置き場所の中だけ開ける。相談フォルダ・他の相談者の置き場所は開けない
- 登録テスト (cc.acceptance.json) が通る

## 未確認として残すもの

- 実際の相談部屋で添付を送り、claude (Opus) と codex (Astra) の両方で中身を読めること (権限規則 `//c/...` と view_image のフック経由)
