---
task: delegation-actio-team-id
project: Concordia
kind: 実装
status: review
created: 2026-10-01T00:00:00.000Z
source_session: lictor-674b93f6-c147-4013-a365-5543570af74d
memoria_task_id: null
pr_number: null
actio_task_id: actio:64ae686f-78e7-4c07-9ad1-037cc3e99aa1
memory_links: []
---
# 委託 invoke の Actio タスク登録: 失敗理由を返し、複数チームのプロジェクトでも委託できるようにする

設計正本: `spec/feature/task-workflow-v3.md` CC-AT-TEAM-02 (今回追加)。

### 目的

2026-10-01、Cernere (Cr) を対象に実装委託を invoke すると 2 回とも 400
「Actio task registration or execution claim failed; …」で落ち、原因が分からなかった。
Cr は Actio で 2 チーム (LUDIARS-Foundation / GLab) に登録されており、`mergeActioProjectBindings`
が「team registration is ambiguous」を投げ、`service.ts` の `catch {}` がそれを握りつぶしていた。

親セッション経由の neco 補足 (2026-10-01):「タスクはどちらのチームからも登録できる。バックログは
チームに載るので、チームのスプリントに関係ない場合は表示されない」。これに従い、複数チーム登録は
正当な状態として扱い、曖昧エラーで止めることを既定にしない。

### 変更内容

- **理由を返す**: `src/delegation/seal-failure.ts` の純関数 `describeSealFailure` が封印失敗を
  `src/taskflow/failure.ts` の分類 (code / message) に変換する。`service.ts` は従来の固定文言を
  `error` に残したまま (互換)、`details` に `{ code, message }` を載せる。HTTP では `detail` として返る。
  複数チームのプロジェクトでは `candidate_team_ids` と「actio_team_id を指定する」hint を足す。
  例外の生文言・トークン・設定値は返さない。
- **複数チーム = チーム無しバインディング**: `mergeActioProjectBindings` は teamIds が 2 件以上なら
  `teamId: null` + `teamCandidates` (登録 teamIds) のバインディングを作る。0 件 / 1 件は従来どおり。
  接続設定で明示したバインディングが優先される規則は不変。
- **チームの明示**: 純関数 `selectActioTeam(binding, requested)` (`src/taskflow/actio-team-selection.ts`)。
  未指定ならバインディングをそのまま使う (チームを選ばない)。指定はバインディングの team と一致するか
  候補に含まれる場合だけ受理し、それ以外は `ActioTeamSelectionError` (`actio_team_invalid`, 400 相当) で
  Actio への書き込み前に拒否する。設定済み・単一チームの team を上書きしない。
- **入口**: `InvokeInput.actio_team_id` を追加し、HTTP `POST /v1/delegation/invoke` の zod スキーマと
  MCP `delegation_invoke` の inputSchema に足した。`sealDelegationTask` → `TaskStore.create(teamId)` →
  `ActioTaskStore.create` の `selectActioTeam` まで渡す。
- **読み取り範囲**: チーム無しの複数チームバインディングでは、team が null または候補チームの
  タスクを所有範囲内として扱う (`taskTeamInScope`)。明示チームで作ったタスクを、spawn 先が
  リポジトリのバインディング経由で本文取得・担当登録・状態更新できるようにするため。
- Actio がチーム無しタスクを拒否した場合は、元のメッセージを保ったまま候補チームを付けた
  `ActioTeamCandidatesError` に包み直す (分類は failure.ts のまま)。
- spec CC-AT-SCOPE-01 / CC-AT-TEAM-01 の「複数チームは fail closed」記述を CC-AT-TEAM-02 参照に改め、
  CC-AT-TEAM-02 節を追加。

### Actio がチーム無しタスクを受け付けるか (確認結果)

`Actio/modules/task/routes.ts` のソースを確認した (実行はしていない)。`teamId: null` の POST は
input mode が minimal になり、lane / assignee の必須条件も team-project 所属検証もかからない。
Concordia は teamId が無いときは `assigneeId` を送らないので、送信内容 (`actio-task-client.ts`) の
変更は不要。`GET /api/tasks?scope=owned&project=…` は team_id 無しだと同プロジェクトのチームタスクも
返すため、上記の読み取り範囲拡張が必要になった。

### 再利用探索

- 失敗の分類は既存の `describeTaskflowFailure` (failure.ts) を再利用し、新しい code は
  `actio_team_invalid` の 1 つだけ足した。
- チーム検証は Actio 側 `validateTeamProject` と同じ「プロジェクトの teamIds に含まれるか」を、
  Concordia が既に取得している `/api/projects/cc` の teamIds で判定する (追加の API 呼び出しなし)。
- observe runtime は既存の `src/harness/reliability/ontime-runtime.ts` を taskflow / delegation に再公開。

### 変更境界

- 変更: 委託の Actio タスク封印経路、Actio バインディング解決 (複数チーム時のみ)、タスク所有範囲チェック
  (チーム無し複数チームバインディングのときだけ候補チームを許容)、invoke の HTTP / MCP 入力。
- 不変: 0 / 1 チーム登録、設定済みバインディング (bearer / subsidiary を含む)、ローカル team 操作時の
  leader 検証、タスク送信 payload。
- Sidecar 経路 (`guardSidecarInvoke`) は actio_team_id を運ばない (今回の対象外)。

### 復旧方法

- 曖昧で失敗した場合は応答の `detail.candidate_team_ids` のいずれかを `actio_team_id` に指定して
  再 invoke する。指定しなければチーム無しタスクで作られる。
- ロールバックはこの PR の revert のみ (データ移行なし)。

### 受け入れ条件 (契約)

- C-1 describeSealFailure(error): sealDelegationTask の失敗時、invoke 応答に failure.ts の code と message が入り、固定文言だけにならない
- C-2 selectActioTeam(binding, requested): actio_team_id 未指定ならチームを選ばず、複数チームのプロジェクトはチーム無しで作られ run が起動する
- C-3 selectActioTeam(binding, requested): 登録済み teamIds のどれかを actio_team_id に指定すると、そのチームで Actio タスクが作られる
- C-4 selectActioTeam(binding, requested): 登録に無い actio_team_id は受理されず、登録外のチームでタスクが作られない
- C-5 mergeActioProjectBindings(configured, repositories, registered): teamIds が 0 件 / 1 件のプロジェクトの既存挙動が変わらない

### 検証

- 実施: `tsc --noEmit -p tsconfig.json` (本体) と `tsconfig.test.json` (変更テスト) の型検査で
  変更ファイルのエラーなし。Augur `inject apply --rule contract-wrap` で 5 契約を仕込み済み。
- 未実施: 単体・統合テストの実行 (委託方針により人間の指示待ち)。実 Actio での複数チーム委託の
  動作確認、サービス再起動。
- 追加 / 更新したテスト: `actio-team-selection.test.ts`、`seal-failure.test.ts`、
  `delegation-invoke-team.test.ts`、`actio-store.test.ts`、`actio-task.test.ts`、`service.test.ts`、
  `actio-project-binding.test.ts`、`taskflow-project-scope.test.ts` (複数チームの 503 期待を
  チーム無し読み取りに更新)。
