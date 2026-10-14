---
task: site-activity-prs
project: Concordia
kind: 実装
status: review
created: 2026-10-14T12:00:00.000Z
source_session: lictor-66291801-9d68-4ad1-b64b-168731749d4e
memoria_task_id: null
pr_number: null
actio_task_id: "1f93d2a7-733a-423d-9b97-492f8e0e660a"
memory_links: []
---
# 拠点から本社へ送る作業記録に、セッションが提出した PR を載せる

設計の正本: `spec/feature/federation-link.md` の SPEC-FED-SITE-ACTIVITY (「提出した PR を含める」「公開時のチェック」の節)。
Actio のタスク: `actio:1f93d2a7-733a-423d-9b97-492f8e0e660a`。

## 実装内容

- `activity-report` の各セッションに任意項目 `prs` を追加した。項目は出所 (`local` = Revisor の local PR / `github` = Cc の PR 記録)・リポジトリ・番号・題名・状態・URL だけ (`src/federation/protocol.ts`)。
- 上限: セッションあたり 5 件、1 報告あたり 120 件 (本社の検証で超えたら報告ごと拒否)。直列化が 48KB を超えるときは、拠点が古いセッションから落として送る (本社の受信上限 64KB を超えると連合リンクごと切れるため)。
- セッションと PR の対応は既存の記録だけから取る: Revisor の local PR の `sessionId`、`pr_records.author_session_id` (`src/daily/site-activity-prs.ts`)。
- 拠点の送信処理 (`site-activity-reporter.ts`) は送信のたびに PR を引く。取得に失敗したときは PR なしで送る。
- 本社の日報の拠点欄 (`bullets.sites[].prs`) に PR を重複なしで載せ、template 版の日報にも PR の行を出す (`src/daily/site-activity.ts` / `generator.ts`)。
- 後方互換: 旧版の拠点 (`prs` なし) の報告も受け付ける。旧版の本社は新しい報告を読み捨てる (接続は切れない) ので、本社を先に更新する。
- 公開経路の調査: 日報と拠点の記録が Cc の外へ出る経路は無かった (loopback の `/v1/daily-reports` と Web UI だけ。Memoria・Tabula のリポジトリにも利用は無い)。そのため、公開時にチェックを必須とする規則を spec (SPEC-FED-SITE-ACTIVITY-PUBLIC) に書いた。

### 再利用の検討

- PR の取得は既存の `RevisorClient.listLocalPrs()` と `PrRecordsRepo.list({ author_session_id })` を使った。新しい記録や migration は足していない。
- 漏洩チェックの既存実装 (`src/consultation/confidential-terms.ts`) は、公開経路が無いので今回は使っていない。spec の規則で、公開経路を作るときに通すよう定めた。

### 判断が要る点

- 公開経路が無いので、漏洩チェックと非公開リポジトリの除外は spec の規則として書くだけにした。拠点の PR を公開経路 (Tabula・公開チャンネルなど) へ出すかは未定。出すと決まった時点で、この規則に沿って実装する。

### 検証

- 実行: `src/daily/site-activity.test.ts`、`site-activity-prs.test.ts`、`scheduler-site-role.test.ts`、`src/federation/protocol.test.ts`、`site-activity-reporter.test.ts`、`site-activity-store.test.ts` (6 ファイル・27 件すべて成功)、`tsc --noEmit -p tsconfig.json` (エラーなし)。
- 未実施: サービスの起動と実際の拠点・本社間での送受信 (起動テストは指示が無いため行っていない)。

## 完了条件

- [x] C-1 indexSessionPrs(sessionIds, localPrs, githubPrs, limit): 各セッションに載る PR は、提出元の記録がそのセッションのものだけ。同じ PR は 1 件で、上限件数以下
- [x] C-2 buildSiteDayActivity(date_iso, sessions, nowSec, limit, prsOf, maxBytes): 送る報告は上限バイト以下、PR はセッションあたり 5 件・報告全体で 120 件以下。総数は入力のセッション数のまま
- [x] protocol の検証で PR の余計な項目と上限超過を拒否し、`prs` の無い旧版の報告は受け付ける
- [x] 本社の日報の拠点欄に PR が載る
- [x] 公開経路の有無を調べ、公開時のチェック規則を spec に書いた
