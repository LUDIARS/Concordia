---
task: 2026-10-14-bounty-guidance-events
project: Concordia
kind: 実装
created: 2026-10-14
actio: actio:43f082ca-7c5d-4b52-befc-99e91120029f
source_session: lictor-a351cfbc-e902-4931-aee7-2133698eadbf
memory_links: []
---
# バグバウンティ: 通常のバグ報告 (bug-report) を案内し、期間を決めた企画を催しとして足す

設計正本: `spec/feature/bug-bounty.md` §0・§8.1・§8.2・§18 (`SPEC-BOUNTY-EVENT` / `SPEC-BOUNTY-GUIDANCE` /
`SPEC-BOUNTY-WEBUI` / `SPEC-BOUNTY-REWARD`)。ドメイン `bug-bounty` (支援)。Actio `actio:43f082ca-7c5d-4b52-befc-99e91120029f`。
Pf フラグメント 01M4VTCSKNDRE9TFRTW86A9ZAK (案内) / 01M4VTCSKDMVQGTC1FX76HVADM (企画)。2026-10-14 neco「このへんやる」。

### 目的

作業中のエージェントに、作業の範囲外で見つけた不具合を通常のバグ報告 (スキル `bug-report`、Actio) で出す経路を
案内し、開催中のバウンティ企画があるときだけ企画の経路を併記する。企画は「報告の受付条件」ではなく、期間・対象・
受付口・案内文・報奨の上書きを持つ催しとして足す (2026-10-04 訂正「報告は常時できる」は維持)。

### やったこと

- 案内: `workflowGuidance` に種別 `bug-report` (サービス Actio、スキル `bug-report`) を追加。`bug-bounty` は開催中の企画が
  渡されたときだけ、題名・期間 (JST)・対象・案内文と企画の経路を添えて並べる。ハーネスの意図判定では入力の対象プロジェクトを
  含む企画だけに絞る。起動時の共通案内は `bug-report` の 1 行 (節度を含む) と、開催中の企画ごとの 1 行。経路を示すだけで自動で
  報告しない節度は維持。
- 企画: migration 136 `bug-bounty-events` (`bounty_events`、`bounty_reports.event_id` は NULL 可) と凍結台帳・スキーマ指紋。
  純関数 `src/bounty/event-policy.ts` (段階・紐付け・検証・報奨の上書き)、use case `event-service.ts`、repo
  `src/db/bounty-events-repo.ts`。受付は開催中・対象プロジェクト・受付口が当たる企画に報告を紐付け、企画外の報告もそのまま
  受け付ける (指定した `event_id` が当たらないときだけ 400 `event_not_applicable`)。
- 報奨: 紐付いた報告は企画の深刻度ごとの上書きを個人の AI 予算の `requestReward` に `tokensOverride` として渡す (予算側は段が
  決まるときだけ使い 1 件の上限で頭打ち)。
- API と WebUI: `GET /v1/bounty/events`、`POST /v1/admin/bounty/events`・`PATCH /v1/admin/bounty/events/:id`・
  `POST /v1/admin/bounty/events/:id/end`。`/bounty` に企画の一覧・作成・編集・早期終了と、報告一覧の企画での絞り込み (企画外を含む)。
- spec: §0・CC-BOUNTY-INV-11・§3・§8.2・§9・§10・§11 を訂正に合わせて書き換え、§16.6・§17.8 の「作らなかった」を改め、§18 を追加。

### 再利用探索の採否

- 採用: 紐付けの判定は既存の純関数 + use case + repo の分割 (intake / project-scope) に倣った。報奨は個人の AI 予算の既存 port
  (`requestReward`) に任意の `tokensOverride` を足すだけにし、加算量の上限と一意性は予算側に残した。管理面の書き込みは既存の
  `/v1/admin/bounty/*` (adminAuth) にそろえた。報告由来の文の無害化は `neutralizeReportText` を再利用。
- 不採用: 企画の期間判定を SQL だけで行う案 (早期終了の扱いを純関数とテストで固定するため、照会は SQL・判定は純関数に分けた)。
  harness / control から bug-bounty を直接 import する案 (層を跨がないよう、案内に渡す形を `src/shared/bounty-event-notice.ts` に置いた)。

### 判断が要る点

- 対象が重なる企画が同時に開いていて受付口が `event_id` を渡さないとき、旧設計は「選ばせる (必須)」だったが、報告を常時受け付ける
  訂正と両立させるため「終了の早い企画」に決めた。`/bug` のモーダルには企画の選択を足していない。
- 書き込み API は設計の `/v1/bounty/events` ではなく admin 配下 (`/v1/admin/bounty/events*`) に置いた (権限者の操作を他と同じ境界へ)。
- 「権限者」は WebUI の管理面 (adminAuth) とした。Discord から企画を操作する経路は無い。
- 受付時にプロジェクト不明の報告は、仕分けがプロジェクトを推定しても企画に紐付けない (後から付け替えない)。
- 並行の委託が migration 136 を使うと衝突する。提出時点の main (22f62329) では 135 が最新。

### 検証

- 実行したテスト (変更に対応するものだけ): `src/bounty/event-policy.test.ts`・`event-service.test.ts`・`flow.test.ts`・
  `intake-service.test.ts`、`src/api/bounty-events.test.ts`・`bounty.test.ts`・`bounty-flow-api.test.ts`、
  `src/db/bounty-reports-repo.test.ts`・`migration-ledger.test.ts`、`src/personal-budget/reward-service.test.ts`・`reward-policy.test.ts`、
  `tests/bounty-guidance.test.ts`、`src/control/startup-policy.test.ts`、`src/api/sessions/startup-policy-check.test.ts`、
  `tests/harness-reliability/*`、`web/src/pages/Bounty.test.tsx`・`BountyEvents.test.tsx`。すべて成功。ただし
  `tests/harness-reliability/conflux.test.ts` の実 Git を使う 1 件は `git switch` が手元の環境で失敗した (本変更とは無関係)。
- `npm run build` (型検査と WebUI のビルド) は成功。Anatomia `pr-review` の 5 ゲートは pass。Augur の契約 lint で今回の契約の指摘なし。
- Augur の契約集計は、テスト (vitest) では観測が記録されないため今回の 4 契約とも未観測。本番プロセスでの観測が要る。
- 全件テスト・サービスの起動確認・画面のスクリーンショット確認は未実施。

### 完了条件

- [x] クラシファイアに種別 `bug-report` を足し、開催中の企画があるときだけ `bug-bounty` を併記する。起動時の共通案内も合わせる。
- [x] `bounty_events` (migration 136) と `bounty_reports.event_id` (NULL 可)。凍結台帳に登録する。
- [x] 受付で、開催中・対象プロジェクト・受付口が当たる企画に報告を紐付ける。企画外の報告も受け付ける。
- [x] 紐付いた報告の報奨に企画の上書きを使う。
- [x] 企画の一覧・作成・編集・早期終了の API (書き込みは admin 配下) と WebUI。報告の一覧に企画の絞り込み。
- [x] spec §17.8 の「作らなかった」を書き換え、§18 に確定した点を書く。
- [x] テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。

### 扱わないもの

- Cocoiru からの報告 (分割 6)。
- `/bug` のモーダルでの企画の選択 (受付が対象プロジェクトから決める)。
