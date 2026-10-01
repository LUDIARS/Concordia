---
task: 2026-10-02-consult-closure
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# 相談課の後始末と出力の絞り込み (共有ダイアログ・チャンネル削除・FINAL ANSWER のみ)

設計正本: `spec/feature/tech-consultation.md` §6 §7、`spec/feature/departments.md` §9.4 §9.5。
2026-10-02 neco 指示 (相談課: 執行役員のみ閲覧・初期 Inject のみ・技術者レベル・FINAL ANSWER のみ・コンテキストサイズ不要・
流出チェック・終了後の共有ダイアログとチャンネル削除)。設計は「推奨案で着手」、plan は director case
`dir_5b9949b72c6e43dc92066e5a32fa7a8e` v1 で承認。

## 目的

相談チャンネルを、相談者本人と執行役員だけが見る使い捨ての場にする。回答だけを流し、終わったら共有するかを
本人に聞いてチャンネルを片付ける。社内の情報が相談セッションと共有の要約に混ざらないようにする。

## タスク分解

1. migration 122: private_consultations に wrap_status (pending/asking/done/legacy)・share_asked_at・channel_deleted_at。既存行は legacy。凍結台帳と SCHEMA_FINGERPRINT を更新。
2. consultation/closure-policy.ts (純関数): 24 時間の期限、会話の文字起こし、判定プロンプト、判定の読み取り (読めなければ共有しない)、秘匿語・プロジェクト名の検出 (件数のみ)。
3. consultation/closure-service.ts: セッション終了・24 時間で閉じる → 本社は claude -p で判定し、公開できて流出語が無ければ「この内容を全体共有しますか？」→ 24 時間反応なしは「共有しない」→ 答えが出たらチャンネル削除。子会社は問わない。
4. consultation/confidential-terms.ts: 秘匿語辞書の読み込み (語はログに出さない)。
5. publication-service: proposeOnClose / expire、API share-proposal / expire。
6. Bot 配線: セッション終了で closeConsultation、10 分ごとの sweep、判断カード操作後に onShareDecided、カード文言、チャンネル削除、24 時間超のセッション停止。
7. spec: tech-consultation §7、departments §9.4/§9.5、cc.acceptance.json、Augur 登録テスト。

## 受け入れ条件

- [ ] 単体テスト: 期限・判定の読み取り・流出検出・状態遷移 (二重に問わない・失敗は次回再試行)・API。
- [ ] 型チェックと関係テストが緑。
- [ ] Revisor の local PR → マージ → build・再起動 → 本社 / GLab の技術相談課で動作確認 (人)。
