---
task: 2026-10-02-bounty-intake
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 1/5 — 企画と報告台帳と受付、クラシファイアの案内

設計正本: `spec/feature/bug-bounty.md` §0・§3・§4・§8.1・§9・§10・§11 (`SPEC-BOUNTY-EVENT` / `SPEC-BOUNTY-INTAKE` /
`SPEC-BOUNTY-REPORTER` / `SPEC-BOUNTY-GUIDANCE`)。価値 UX-CC-W7 / シナリオ UX-CC-S8。ドメイン `bug-bounty` (支援)。
2026-10-02 neco 指示「バグバウンティはあらゆるセッションから有効」「Cocoiru または Cc (Discord) から気軽に」「実装 Opus」。
同日の訂正「バグバウンティはバグレポートのイベント企画の一種であって、バグレポート全てをバウンティにしたいわけではない」:
受付は開催中の企画の対象プロジェクトだけ。通常のバグ報告 (Castra のスキル `bug-report` → Actio) はこのタスクの範囲外。

## 目的

開催中のバウンティ企画へ、Discord の `/bug`、セッションの API、Cocoiru のどこからでも報告でき、外部が落ちていても
報告を失わない受付を作る。以降のタスク (仕分け・反映・報奨・公開・WebUI) が乗る企画・台帳と状態遷移を用意する。

## 完了条件

- [ ] `bounty_events` / `bounty_reports` (`event_id` NOT NULL) / `bounty_report_events` / `bounty_reporters` を migration で作る
      (番号は未マージの並行ブランチも見て採番する)。
- [ ] 企画の判定を純関数で持つ: 時刻・対象プロジェクト・受付口から「受け付ける企画」を 1 つ決める。該当なしは
      通常のバグ報告の案内付きで拒否、対象が重なる複数の企画は `event_id` の指定を求める (CC-BOUNTY-INV-11)。
- [ ] 企画の作成・編集・早期終了の use case と `GET/POST /v1/bounty/events`・`PATCH /v1/bounty/events/:id` (権限者だけ)。
      開始済みの企画の対象プロジェクトは減らせない。
- [ ] 状態遷移の可否を純関数で持ち、台帳は状態の CAS で更新する。遷移ごとに履歴を 1 行残す。
- [ ] 受付 use case: 台帳へ書いてから応答する。同じ冪等キーの再送は同じ報告 id を返す (CC-BOUNTY-INV-02 / 03)。
- [ ] 受付 use case は企画の判定と台帳への書き込みを同じトランザクションで行い、終了時刻を過ぎた書き込みを拒む。
- [ ] `POST /v1/bounty/reports`: 有効な `session_id`、または Bot が渡す操作者で受ける。未知のプロジェクトコードと
      開催中の企画の対象外は 400 (通常のバグ報告の経路を返す)。子会社は関係プロジェクトの範囲だけ (CC-INV-02)。
- [ ] Discord `/bug` (本社・子会社 guild): 開催中の企画が無ければモーダルを開かず案内を返す。モーダル (企画・対象プロジェクト・
      何が起きたか・再現手順・公開名)。応答は本人にだけ返し、受付の告知は報告 id と対象プロジェクトだけにする。
      `/bug name` で公開名を変えられる (本人だけ)。
- [ ] 報告者・受取人の解決: 人は `bounty_reporters`、セッションは依頼者 (`discord_requester_user_id` と所属会社)。
      特定できなければ受取人なし。
- [ ] 取り下げ (`withdrawn`) は採用前の本人だけ。
- [ ] クラシファイア `workflowGuidance` に `bug-report` を足し、起動時の共通案内に 1 行足す (§8.1)。既定は通常のバグ報告
      (スキル `bug-report`) を案内し、開催中の企画の対象に当たるときだけ企画の経路を併記する。案内は経路を示すだけで
      報告を自動で出さない。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/bounty/`、`src/db/bounty-*-repo.ts`、`src/db/schema.ts`、`src/api/bounty*.ts`、`src/api/register-core.ts`、
  `src/bootstrap/core.ts`、`src/discord/bounty-*`、`src/discord/commands/bug.ts`、Bot のコマンド登録の配線
- `src/harness/reliability/workflow-guidance.ts` と起動時の共通案内の組み立て
- `tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md` (実装で確定した強制箇所の追記)
