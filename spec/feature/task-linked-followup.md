---
title: Actio タスクに紐づく作業案内と継続
type: feature
id: CC-TASK-LINKED-FOLLOWUP
domain: session-coordination
status: draft
---

# Actio タスクに紐づく作業案内と継続

## 利用者の価値と所有者

UX-CC-W1/W2/W4、シナリオ S1/S2/S5 を対象にする。別の指示・タスクへ切り替えたとき、
セッション全体の「作業段階」が未確認へ戻り、既に合意した別タスクの作業を阻む状態を避ける。
Actio がタスクの状態・担当・依存関係・関連 PR の正本を所有し、Cc は人間の指示参照と
対応する Actio タスク参照の関連を所有する。Cc に第二のタスク状態を保存しない。
session-coordination は協調のコア候補、http-interface はその操作を提供する支援境界。

## 契約

- 人間指示への参照と `actio:<id>` を明示して関連付ける。指示本文の複製や推測による
  タスク新規作成は行わない。複数の指示・タスクの関連を保持し、同一関連の再登録は冪等にする。
- 関連付け時に既存 TaskStore を通じて repo/subsidiary の所有スコープを照合する。
  外部待ちの前後でセッション binding を照合し、対象が変わった結果を保存しない。
- 取得時は Actio の現状態を読む。参照不能は未確認と明示し、Cc の古い状態で承認済み・
  完了に置き換えない。取得量・並行数・保存する参照数を制限する。
- 主 Inject と自動確認はタスク参照を中心とし、legacy `cc_work_phase` を作業全体の
  正本や自動再開条件にしない。既存の実装契約・承認証拠・権限判定は別契約として維持する。
- 既存 Actio 状態を使い、この変更だけで新たな細分化 phase や実行権限を作らない。

### 旧来タスク (cc-taskmd) の参照 (2026-10-02)

Cc taskflow v3 以前の形で登録された Actio タスク (source `cc-taskmd`、タスク md を本文にしたもの)
も、人間の指示への参照として関連付け・状態表示ができる。neco 2026-10-02 の指示。

- 状態所有者は変わらない (Actio)。Cc は参照だけを持つ。
- 参照用の読み込み (`TaskStore.readReference`) は taskflow の作業用読み込み (`read`) と分ける。
  旧来タスクは作業候補・状態更新・担当割り当ての対象にならず、taskflow state にも登録しない。
- 受け入れる範囲 (不変条件):
  - v3 タスク: 従来どおり (project・owner・team・source・pluginId がすべて binding と一致)。
  - 旧来タスク: source が `cc-taskmd`、project と owner が binding と一致、team は binding の
    範囲内か、team を持たない場合は owner が一致すること (依存タスクの読み込みと同じ規則)。
  - ~~それ以外の source (手入力・他サービス由来等) は従来どおり範囲外として拒否する。~~ 2026-10-23 に改める (下記)。

### 参照範囲は source で決めない・紐付けの binding 候補・unknown を一度だけ示す (2026-10-23)

不具合 Actio 162bc3a6 (MELPOT の作業セッションで紐付けが 403 `actio_task_out_of_scope`、自動確認が state=unknown の
まま繰り返し届く) の修正。taskflow タスク `actio:5e1f2bed-8f6a-403c-a9d2-93ec2da419be`。

- 原因 1: 参照用の読み込みが source `concordia.taskflow.v3` / `cc-taskmd` 以外を一律に範囲外にしていた。Actio の実データでは
  Cc プロジェクトの `cc-command` (Cc の不具合報告) 26 件、別プロジェクト由来の `memoria-import` がすべて紐付け不能だった。
- 原因 2: 紐付けは `target_project` の binding だけで引くが、`target_project` は current_task / branch の文面から推定される
  (branch `fix/actio-…` で Actio になる)。実 checkout のプロジェクトのタスクが範囲外になっていた。表示は `repo_path` で
  引いていて、紐付けと食い違っていた。
- 因果の確認: 紐付けが 0 件だと自動確認の tasks が空になり state=unknown。unknown は AI 作業扱いでないので、3 アウトまで
  同じ本文が繰り返される。

変更後の不変条件:

- v3 以外のタスクの参照範囲は project・owner・team で決める (`isReferenceInScope`)。source は問わない。
  project・owner・team のどれかが合わないタスクは従来どおり `actio_task_out_of_scope` (403)。参照専用で、作業候補・
  状態更新・担当割り当てには使わない (従来どおり)。v3 タスクの範囲は変えない。
- 紐付けは「宣言した作業対象 → 実 checkout」の順に binding を試す (`sessionTaskRepoCandidates`)。次へ進むのは範囲外のときだけで、
  404・Actio 不通はそこで確定する。表示は紐付けたときの binding (`link.repo_path`) で読む。
- 範囲外・未存在で拒否した参照は理由とともにセッション metadata `cc_task_link_failures` に残す (最新 4 件、同じ参照は上書き、
  紐付けに成功したら消す。Actio 不通は残さない)。自動確認はこれを「関連付けできなかった Actio タスク」として示す。
- 自動確認は unknown の中身 (タスクの unknown 理由・関連付けできなかった参照・取れなかった取得元) を鍵にし、同じ鍵の unknown は
  一度だけ送る (`cc_followup_unknown_notice`)。中身が変わるか、unknown 以外の状態で一度送れば、次の unknown はまた一度送る。
  状態照会を持たない構成は従来どおり 3 アウトに任せる。
- 実装: `src/taskflow/actio-reference-scope.ts`、`src/taskflow/actio-task-client.ts`、`src/work/session-task-links.ts`、
  `src/work/task-link-failures.ts`、`src/control/session-followup-snapshot.ts`、`src/control/session-followup-state.ts`、
  `src/control/unknown-followup-notice.ts`、`src/control/stalled-session-nudge.ts`。

## Goal & Go と人間待ち

マージまで許可された対象作業の 1 ループは、PR 提出・Test OK で区切らず、PR の
指摘修正・再審査・マージ・反映確認まで追う。各操作の権限は人間の既存指示から確認する。
未許可の操作や Test OK を完了扱いにしない。止まったタスクがあっても、同じ承認範囲で
進められる別タスクを確認する。結果不明の提出・マージを再送せず、審査ゲートと明示された
人間判断待ちを守る。
ループの区切りでは、予定タスクを列挙し、実行中は `GO`、待機には理由を表示する。
進められるものがなければ必要な人間判断を要約して待機する。

未回答の質問・明示された人間待ちでは自動確認と Goal & Go の自動注入を止める。
質問カードへの回答、または `discord:<uid>:…` / `slack:<uid>:…` の正規人間入力 source がある応答だけで待機を解除する。AI の返答やタイマー経過は解除しない。
Lictor の `user_activity` は物理端末のキーストロークであり、回答送信ではないため解除に使わない。通常のローカル TUI 入力には送信確定を示す専用イベントがまだなく、この経路だけでは明示待機を自動解除できない。今回の Cc 変更に Lictor の新イベントは含めない。
外部状態取得中に binding や待機状態が変わった場合も、直前に再照合して注入を抑止する。

### チーム未設定タスクと状態取得の失敗理由 (2026-10-09)

Actio のプロジェクトに登録チームが 1 つだけのとき、binding はそのチームで固定される。一方、既存の
taskflow v3 タスクはチーム未設定 (`teamId: null`) で作られたものが残っており、これを範囲外として
弾くと関連タスクの状態が常に unknown になる (Cc プロジェクトで 132 件全件が該当した)。

- binding のチームが 1 つに確定しているとき、チーム未設定タスクは範囲内として読み取り・実行してよい
  (neco 2026-10-09)。別チームのタスクは従来どおり範囲外。
- 1 件取得 (`get` / 参照読み込み) でチーム未設定タスクに当たったら、確定しているチームを Actio へ書き込む
  (遅延バインディング)。ローカル認証では作成時と同じく担当者に binding の owner を入れる。
  書き込みが失敗しても読み取り・実行は止めず、理由をログへ残して次の取得で再試行する。
- 関連タスクの状態が取れなかったときは、unknown の理由 (`not_found` / `task_out_of_scope` /
  `task_unavailable` / `status_unrecognized`) を表示とログに出す。例外を握りつぶして理由を消さない。
- 自動確認は Actio・Revisor 登録一覧・Revisor local PR を個別に取得し、取れなかったものだけを
  名指しで示す。1 つの失敗で他の取得結果まで捨てない。

## 報告

ドメイン名をコードブロックで示し、UX 価値、specRefs、責務、実際のコア/支援分類、
実施・未実施検証を添える。Pf の仕様ページと An のドメイン/関数マップは現行の
登録情報からリンクが確認できた場合のみ付ける。未登録・未確認はそのまま示し、仕様ファイルを参照する。

## 受入条件と復旧

- タスク A/B の状態と承認を混ぜず、current_task の文面変更だけで A を未確認へ戻さない。
- 関連の冪等性、参照スコープ違反、binding 切替中の応答、Actio 不通を区別する。
- 人間待ち中は両自動注入経路が送らず、実人間の応答後のみ再開候補になる。
- 取得失敗時は同じ作成/操作を再送せず、保存済み参照から再照合する。
- 旧 phase API は互換性のため残しても、主案内に legacy phase の書込を要求しない。

本書の受入条件はテストの実施証拠ではない。テスト実行・サービス操作は本セッションの許可範囲に従う。
