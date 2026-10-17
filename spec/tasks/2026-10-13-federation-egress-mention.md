---
task: federation-egress-strip-site-mention-id
project: Cc
kind: implementation
created: 2026-10-13
---
# 連合 egress のメンション信頼境界

- Actio: actio:cd4802dd-0a95-412b-9461-a5f79a33729a
- 所属: federation（既存 src/federation/ の membership を利用）。新規ドメインなし。
- 価値: UX-CC-W1 / UX-CC-S1、CC-INV-02。拠点からの送信で本社の任意の利用者を通知対象にされない。
- 用語・所有者: 拠点は mention_requester で通知を依頼し、本社のスレッド台帳だけが requesterId を所有する。
- 不変条件: CC-FED-EGRESS-MENTION-01。executor に届く mention_user_id は本社台帳由来だけ。

## 受け入れ条件

C-1 prepareEgressDelivery(request, mentionUserId): 拠点由来の mention_user_id を除去し、本社台帳が返した ID がある場合だけその ID を配送へ付ける

## 作業と検証計画

- [x] 既存 requesterMentionFor、runtime の配送境界、protocol の passthrough を確認。
- [x] Augur plan を実行。再現を回帰テストにし、変更範囲を限定する計画を採用。
- [x] 契約述語・配送整形の純関数を用意し、runtime の executor 呼出しに接続。
- [x] 既存 remote-question.test.ts に mock listener 経由の回帰を追加。実サービスは起動しない。
- [x] mention_requester 無し、false、依頼者の無い台帳、台帳無しでは ID が無いことを確認。
- [x] mention_requester=true と本社依頼者が揃えば本社 ID だけが渡ることを確認。
- [x] 対象テスト単体、typecheck、契約集計を実施（下記の制約あり）。全体テスト・サービス操作は対象外。
- [ ] Concordia コミット、Revisor local PR、通知によるマージ完了確認。

## 再利用・復旧

requesterMentionFor をそのまま使用。protocol の passthrough と配送 adapter は変更しない。
配送整形だけを純関数へ分離し、台帳・認可・再送・資源寿命の既存契約を維持する。
DB 変更なし。問題時は修正コミットの revert を検討するが、任意メンションの問題が再発するため再審査が必要。

## 検証記録

- 修正前: 追加した5ケース中4件で拠点 ID の漏出を再現。
- 修正後: 対象 remote-question.test.ts の10件成功。listener / Villa / Discord への外部通信なし。
- Augur: 配送5ケースで契約 observed、違反0。Vitest の通常ログ無効化を補う一時 setup から実際の vgWrite イベントだけを JSONL に保存して集計した。
- 集計はリポジトリ全97契約を対象とし、今回の1件は充足、対象外96件は未実行。この報告範囲の問題を成功へ読み替えない。
- typecheck の既存エラーは対象外として PR に列挙。全体テスト、サービス起動、デプロイは未実施。
- 契約自動挿入の .ts import は既存ビルドに合わせ .js へ修正。

型検証結果: tsconfig.json は成功。tsconfig.test.json は変更外の6件で失敗: startup-policy-check.test.ts:50、consult-fetch-link.test.ts:2、safety-runtime.test.ts:9、chores.test.ts:156、forum-site-tags.test.ts:125、usage-budget-spawn.test.ts:27。今回変更したファイルの型エラーは無い。
