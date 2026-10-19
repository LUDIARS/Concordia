---
title: 会社内のピン止め・保存操作の共有
id: CC-COMPANY-PIN-SHARING
status: draft
domain: chat-platforms
---

# 会社内のピン止め・保存操作の共有

依頼: 2026-10-19 neco。Actio: 07f5c6e6-1651-4c30-84a4-5379f5e3b7d8。
UX-CC-W15 / UX-CC-S16。失いたくない状態は、会社内の参加者が他の会話で
選ばれた有用な内容を雑談で発見し、原文へ戻れること。

## 対象と責務

支援 domain `chat-platforms` が共有判断・配送台帳・Discord adapter を所有する。
コアの作業状態や保存先 Memoria の状態は変更しない。
Discord の新規 pin 通知と、`memoria-note` / `repo-memory-good` / `repo-memory-bad`
の実行通知を入口にする。絵文字の見た目で判定しない。
既存の 📌 transcript 再束縛は pin ではなく、対象外。
Discord が生成する pin 通知を使うため、Bot による通常 pin も対象。
起動前の既存 pin の遡及共有、unpin による投稿削除、添付ファイルの複製は対象外。

RWF は inject を渡した後、または headless が成功した後に共有する。
表記は「保存操作の対象」であり、保存先の永続化完了を主張しない。
権限拒否・設定不足・失敗・無効化では共有しない。単発絵文字は実際の対象投稿を
message map で解決できる場合だけ共有し、絵文字そのものや別チャンネルを代用しない。

## 不変条件

- CC-PIN-01: runtime の guild と会社別 layout の雑談だけへ配送する。別 guild、
  別会社のセッション、プライベート相談・チャンネル・private thread は除外する。
  元チャンネル（public thread は親）の ViewChannel / ReadMessageHistory の
  overwrite が雑談と一致する場合だけ転記する。比較不能・権限不一致は fail closed。
  年齢制限付きの元投稿は年齢制限なしの雑談へ転記しない。
  雑談自身からの共有は行わず、Bot 投稿ループを作らない。
- CC-PIN-02: 本文を原文として引用し出典リンクを付ける。長文は UTF-8 txt 添付に
  して省略しない。添付・embed の実体は複製せず原文へ案内。メンションと link preview は無効。
- CC-PIN-03: 会社別 discord_config の CAS で guild/channel/message の配送権を
  外部送信前に一度だけ確保する。pin と保存操作は同じ元投稿なら重複させない。
  `sending` → `sent` / `unknown`。通信失敗・停止中の sending は結果不明として
  自動再送しない。再起動でも台帳を保持する。本文や秘密は台帳に保存しない。
- CC-PIN-04: 実行通知は元操作を失敗へ変えない。停止後は送信を始めない。
  同時処理上限を設け、上限・未設定・権限不足・結果不明は本文なしのログへ残す。

## 実装所属と検証

`src/discord/company-pin-sharing-policy.ts` / `.test.ts`: 純粋な共有判断・表示。
`src/discord/company-pin-sharing.ts` / `.test.ts`: Discord adapter と配送手順。
`src/platform/reaction-workflow.ts` / `reaction-workflow.test.ts`: 実行通知。
`src/discord/reactions.ts` / `reactions.test.ts`、`ingress.ts` / `ingress.test.ts`:
元投稿の同定。`bot.ts`: runtime 配線（adapter テストと型検査で確認）。
全て既存 chat-platforms membership に所属する。受入対応は cc.acceptance.json。
実環境の投稿・再起動テストは別途許可の範囲で行い、未実施を成功としない。

復旧: ロールバック時も台帳を残す。unknown/sending は Discord の出典リンクと
投稿 ID を照合するまで再送しない。既存 RWF の実行と共有配送は独立して扱う。
