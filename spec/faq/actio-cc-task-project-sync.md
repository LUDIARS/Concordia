---
tags: [actio, taskflow, delegation, project-codes, sync]
date: 2026-10-11
kind: design
---

# Q: Actio と Concordia が同じタスクとプロジェクトを持つには、どう同期させるべきか

neco の指示 (2026-10-11):「Actio と Concordia は同一のタスクを持つべき。Actio と Concordia のプロジェクトがズレているので同期した方がいい」

この文書は調べた結果と設計案です。実装はまだしていません。調査は読み取りだけで行い、2026-10-11 時点の稼働中データを使いました。

- Concordia `GET /v1/project-codes`
- Actio `GET /api/projects/cc`、`GET /api/tasks?scope=all`
- Concordia `concordia.db` (readonly で開いた)

ポートは各サービスの `excubitor.catalog.yaml` を正本としました (Concordia 11111、Actio 17880)。

## 1. 結論

- **プロジェクト登録そのものはずれていない。** Cc の `project_codes` は 106 件、Actio の `project_refs` も 106 件で、code と名前は全件一致しています (Actio は今日 14:44 に同期済み)。
- **ずれているのは、タスクがどのプロジェクトに属しているかの方。** Actio の 3,605 件のうち 2,859 件は `projectId` が空です。このうち 1,007 件は open か in_progress です。どれも Memoria から取り込んだタスクで、Cc の taskflow からは見えません。
- **Cc と Actio は同じタスクを見ていない。** Cc が見ているのは、自分が作った `concordia.taskflow.v3` の 696 件だけです。一方で Cc 側には、Actio に載っていない旧 md タスクが 843 件あります。
- **重複は、委託の実行 1 回ごとに Actio task を 1 件新しく作る設計から生じている。** 引き継ぎで委託すると本文が変わるので、重複を見分けるキー (`sourceRef`) も変わり、新しい task ができます。前の task は in_progress のまま残ります。
- **推奨は案 A:「Actio をタスクの正本、Cc をプロジェクトの正本」とする片方向の分担。**
  - Cc は Actio task ID (`actio:<id>`) を参照するだけにします。
  - 委託の実行回 (run) は task に紐づけるだけにし、run のために task を作らないようにします。
  - これに加えて、既存のずれを dry-run で一覧にしてから、人の承認を経て解消します。

## 2. 現状分析

### 2.1 プロジェクト

| 観点 | Cc | Actio | 判定 |
|---|---|---|---|
| 正本 | `project_codes` テーブル (`src/db/schema.ts:1839`)。code は大文字小文字を区別し、project / repo_path / repo_origin は一意 | `project_refs` (code PK / name / team_ids / synced_at / removed_at) | Cc が正本、Actio はその写し |
| API | `GET /v1/project-codes`、`GET /v1/project-codes/admin` (teams を含む) | `GET /api/projects/cc`、`GET /api/teams/:teamId/projects` | — |
| 同期 | — | `modules/task/team/cc-project-sync.ts`。10 分ごとの tick で `/v1/project-codes/admin` を取得して upsert する。消えた code には `removed_at` を付ける。repo_path は保存しない | 片方向の pull |
| 件数 | 106 | 106 | **差 0** (片方にしか無い code 0、名前の違い 0) |

Cc が Actio のプロジェクトを引く経路は `src/taskflow/actio-project-binding.ts` の `mergeActioProjectBindings` です。Cc の repo 登録と Actio の `project_refs` を code の完全一致で突き合わせて binding を作ります。

- チームが 1 つなら、そのチームに紐づけます。
- チームが複数 (Cr、KD) なら、チームを決めずに候補だけを持ちます。

登録表そのものではなく、次の 4 つが「ずれ」として表に出ています。

| # | ずれ | 件数 | 原因 |
|---|---|---|---|
| P1 | `projectId` が空のタスク | 2,857 (うち open / in_progress は 1,007) | `memoria-import` (2026-09-26〜10-01) が `projectId` を付けずに取り込んだ。プロジェクト名は `category` の自由記述 (例: `Concordia, 確認作業`、`Di開発`) にしか残っていない。`category` を名前・code で完全一致させると解決できるのは 487 件。残りは種別語 (`実装`、`確認タスク` など) か複合語 |
| P2 | 削除済み code を指すタスク | 2 (`LwP`) | Ludellus-Praeforma の code が `LwP` から `LP` に変わった。Actio は `removed_at` を付けるだけなので、タスクは古い code のまま残る。code の付け替え (改名) を同期が扱っていない |
| P3 | プロジェクトにチームがあるのに `teamId` が空のタスク | 246 (うち open は 206)。多い順に Cc 151、Cr 46、At 15 | Cc の `/projects` でチームを割り当てる前に作られたタスクが、割り当て後も team-less のまま残っている。`bindTeamLate` が team を付けるのは、そのタスクを個別に読んだときだけ。Actio のチーム計画表・スプリントには出てこない |
| P4 | チームを持たないプロジェクト | 32 code (Aes、Bb、Mm、Os など)。これらに属するタスクは 174 件 | Cc 側でチームが未割り当て。Actio では個人タスク扱いになり、チームの画面には出ない |

注意: 大文字小文字だけが違う code が 3 組あります (`LD`/`Ld`、`LP`/`Lp`、`MN`/`Mn`)。Cc も Actio も code を区別して扱うので、いま壊れてはいません。ただし `ActioTaskStore.binding` はプロジェクト名で探すとき小文字に変換するので、code で探す経路を足すと衝突します。

### 2.2 タスク

| 区分 | Cc 側 | Actio 側 | 対応 |
|---|---|---|---|
| taskflow v3 (`actio:<id>`) | `taskflow_task_state` 696 行。本文は持たず、状態の写しと run の対応を持つ | `source=pluginId=concordia.taskflow.v3` 696 件 | **ID は 1 対 1 で全件一致** |
| 旧 md タスク (`spec/tasks/*.md`) | `taskflow_task_state` 843 行 (pending 715 / delegated 8) | 無し | Cc にしか無い。`findByRelativePath` は「Legacy task file references require explicit Actio migration」で拒否する |
| Memoria から取り込んだもの | 無し | 2,857 件 | Actio にしか無い (P1 と同じ集合) |
| Actio で人が作ったもの・cc-command | 無し | 38 件 | Actio にしか無い。Cc の `client.list` は `pluginId=concordia.taskflow.v3` で絞り込むので見えない (依存先として読むときだけ取得する) |
| Cc の予備タスク (`cc_tasks`、`src/fallback-tasks/`) | 0 行 | — | 未使用 |

**状態の写しがずれている:** 696 件のうち 181 件で、Cc の `taskflow_task_state.status` が Actio と食い違っています。

- Cc は pending だが Actio は in_progress: 138 件
- Cc は pending だが Actio は done: 34 件
- Cc は pending だが Actio は cancelled: 5 件
- そのほか: 4 件

`ActioTaskStore.document()` は実行時に Actio の status を読み直すので、taskflow の判定は正しく動きます。ただし、この列を直接読む画面や一覧には古い状態が出ます。

### 2.3 重複作成 (今日の実例)

| task | プロジェクト | 作成時刻 | 本文の書き出し |
|---|---|---|---|
| `actio:0a24bd78` | Ludellus-Server | 12:24:51 | 「Ludellus-Server で MMO フィールド移動モックのサーバ側…」 |
| `actio:c7a73509` | Ludellus-Server | 13:36:42 | 「前任の委託セッション (lictor-187a33cd) が…その続きを引き継ぐ」 |
| `actio:5324762b` | Ludellus-Native | 12:24:52 | 「Ludellus-Native で MMO フィールド移動モックの PC アプリ側…」 |
| `actio:3811fd0f` | Ludellus-Native | 13:36:43 | 「前任の委託セッション (lictor-128bb17e) が…」 |

4 件とも Actio では `in_progress` のまま、Cc では `pending` のままで、それぞれ別の run に結びついています。

**作られている場所:** `src/delegation/service.ts:301` が、実装系テンプレートの invoke ごとに `sealDelegationTask` (`src/delegation/actio-task.ts`) を呼びます。そこから `ActioTaskStore.create` → `ActioWorkflowClient.create` (`src/taskflow/actio-task-client.ts:79`) を経て `POST /api/tasks` に至ります。

**重複になる理由:**

1. 重複判定のキーは `sourceRef = sha256([parent_session_id, template, branch, 描画後のプロンプト本文])` です。Actio 側でさらに `projectId / ownerId / teamId` と合わせてハッシュします。**同じ作業でも本文が 1 文字違えば別の task になります。** 引き継ぎの委託は本文が書き直されるので、必ず新しい task ができます。
2. 既存の task を引き継ぐ経路 (`task_binding: "caller"` と `args.taskflow_reference`) はあります。ただし使っているのは daily-goal と会話の引き継ぎ (`src/control/conversation/cc-ports.ts:76`) だけです。親セッションが `delegation_invoke` で続きを頼む一般の経路では、参照が渡りません。
3. 前の run のプロセスが落ちても、その task は閉じられず in_progress のまま残ります。
4. task のタイトルにテンプレートの題名 (`実装委託 (Opus 5.5)` など) がそのまま入ります。このため人が Actio で見ても区別できません。テンプレート名がタイトルの task は 163 件あり、そのうち 128 件が open / in_progress です。同じプロジェクトで同じタイトルの組は 49 組 (余分な task は 118 件)。

## 3. 改善案の比較

| 案 | 正本 | 同期の向き | ID の対応 | 重複防止 | 長所 | 短所 |
|---|---|---|---|---|---|---|
| **A (推奨)** | タスク = Actio、プロジェクト = Cc | プロジェクトは Cc → Actio (今のまま強化)。タスクは Cc が Actio を参照するだけ | Cc は `actio:<id>` だけを持つ。旧 md と Memoria 由来のものは一度だけ移行する | 「作業単位のキー」で task を決め、run は task に紐づけるだけにする | taskflow v3 の方針 (本文は Actio だけに置く) と一致する。Actio の UI で人が直した内容がそのまま正になる | Actio が止まると Cc で新しい task を作れない (今と同じ制約。`cc_tasks` の予備経路で補う) |
| B | タスク = Cc | Cc → Actio に写す (`cc_tasks` の outbox を拡張) | Cc の ID が主、Actio は写し | Cc の `source_key` で一意にする | Actio が止まっても Cc 単独で動く | v3 の方針を逆戻りさせる。Actio で人が編集した内容が上書きされる。Memoria 由来の 2,857 件を Cc に取り込む必要がある |
| C | 正本を決めない | 双方向 (更新時刻・変更ログで突き合わせる) | 両方の ID を対応表で持つ | 対応表と内容ハッシュで照合する | どちらからでも書ける | 競合解決と削除の伝わり方が複雑。今ある状態の写しのずれ (181 件) を構造的に増やす |

A を選ぶ理由: タスクの本文と状態は、すでに Actio が正本になっています (`ActioTaskStore.authoritative = true`)。いまのずれは「Cc が一部だけ写しを持つ」「run ごとに task を作る」「移行が終わっていない」という中途半端な状態から生じています。正本を 1 つに保ったまま、この 3 点を片付けるのがいちばん安く済みます。

## 4. 推奨案 A の中身

### 4.1 タスクの対応

- **作業単位のキー (work key):** 委託から task を作るときのキーを「描画後の本文」から外し、次の順で決めます。
  1. `args.taskflow_reference` が渡されていれば、その task を再利用する (新しく作らない)
  2. タスク仕様ファイル (`spec/tasks/<file>.md`) または設計ファイルのパスを指していれば、`work:<repoKey>:<path>`
  3. どちらも無ければ `work:<repoKey>:<branch>:<題名の正規化>`
- **引き継ぎの自動判定:** 同じ (リポジトリ, ブランチ) に、未完了の task に結びついた run が残っていて、その session が終わっている (lost / ended) 場合は、`task_binding: "caller"` と同じ扱いでその task を再利用します。`delegation_invoke` の入力にも `taskflow_reference` を明示的に渡せるようにし、引き継ぎのテンプレートでは渡すことを必須にします。
- **run と task は多対 1:** `pluginPayload.runs[]` に run_id / session_id / 開始・終了を追記していきます。`claimActioExecution` の「1 つの task は同時に 1 run」という排他は保ち、前の run が終わっていれば新しい run を受け入れます。
- **タイトル:** テンプレートの題名ではなく、タスクの要約 (`task` 引数の 1 行目か spec の題名) を使います。テンプレート名は `pluginPayload.template` に入れます。
- **状態の写し:** `taskflow_task_state.status` は Actio を読んだ結果のキャッシュと位置づけます。照合ジョブ (`ActioTaskStore.scan` を読むだけ) で定期的に上書きするか、この列を直接読む箇所を Actio の取得に置き換えます。

### 4.2 プロジェクトの対応

- 正本は今のまま Cc の `project_codes` とし、Actio は 10 分ごとの pull を続けます。
- **改名を扱う:** Cc の code 改名を `renamed_from` として `/v1/project-codes/admin` に出します。Actio の同期では、`removed_at` を付けるだけでなく、旧 code を指すタスクの `projectId` を新しい code へ付け替えます (P2 の対処)。
- **チーム割り当ての反映:** 同期の tick で `team_ids` が変わったプロジェクトについて、`teamId` が空のタスクを一括で更新します (チームが 1 つならそのチームに付ける。`bindTeamLate` をまとめて実行する版)。P3 の対処です。
- **大文字小文字の衝突:** Cc の code 登録で、大文字小文字だけが違う既存 code があれば警告を出します (既存の 3 組はそのまま残す)。

## 5. 移行手順 (既存のずれ・重複の解消)

どの手順も、まず dry-run で対象の一覧を出し、人の承認を得てから Actio API で更新します。DB への直接書き込みはしません。

| 順 | 対象 | 方法 | 件数の目安 |
|---|---|---|---|
| M1 | 委託による重複 (今日の 4 件を含む) | 同じプロジェクト・同じ branch・引き継ぎ関係にある v3 task を組にする。新しい方を正にし、古い方は `cancelled` にして `pluginPayload.superseded_by` を付ける。`taskflow_task_state` の run の対応も新しい方へ寄せる | 49 組・118 件が候補。目視で確認する |
| M2 | `LwP` → `LP` | タスク 2 件の `projectId` を付け替える | 2 |
| M3 | プロジェクトにチームがあるのに team-less のタスク | チームが 1 つならそのチームに付ける。複数チーム (Cr、KD) のものは一覧にして人が選ぶ | 246 (複数チームは 53) |
| M4 | Memoria 由来で `projectId` が空のタスク | `category` の語を code・プロジェクト名と完全一致で突き合わせて候補を出す。決まらないものは一覧にする。done / cancelled は移行しない | open / in_progress 1,007 件のうち、自動で決まるのは一部。残りは人が判定する |
| M5 | 旧 md タスク (pending 715 / delegated 8) | 明示的な移行スクリプトで Actio に作成する (`sourceRef = work:<repo>:<path>` で一度だけ作る)。対象は最終活動が直近 (既定 30 日、`--legacy-recent-days`) の pending / delegated だけ (§7)。移行し終えた行は `task_path` を `actio:<id>` に置き換える。残りは archive する (`task_path` を `archived:<path>` に置き換える) | 723 |
| M6 | 状態の写しのずれ | 照合ジョブを 1 回走らせ、Cc の status を Actio に合わせる | 181 |

順番は M1 → M2 → M3 を先にします (小さく、すぐ効く)。その後に 4.1 の再利用ロジックを入れて、新しい重複の発生を止めます。M4 と M5 は件数が多く人の判断が要るので、最後に進めます。

## 6. 影響範囲

| リポ | ファイル | 変更内容 |
|---|---|---|
| Concordia | `src/delegation/actio-task.ts`、`src/delegation/service.ts`、`src/delegation/contracts.ts` | work key、引き継ぎの再利用、タイトルの決め方、`taskflow_reference` の入力 |
| Concordia | `src/taskflow/actio-store.ts`、`src/taskflow/actio-task-client.ts`、`src/taskflow/state-store.ts` | run の追記、状態の照合、`associate` の排他条件 |
| Concordia | `src/api/project-codes.ts`、`src/db/project-codes-repo.ts` | `renamed_from` の出力、大文字小文字の衝突警告 |
| Concordia | `spec/feature/task-workflow-v3.md`、`spec/feature/project-code-registry.md` | 正本の分担と work key の仕様を書き足す |
| Actio | `modules/task/team/cc-project-sync.ts`、`cc-project-parse.ts` | 改名の付け替え、チーム割り当ての一括反映 |
| Actio | `spec/feature/task-integration/spec.md` §6 | 上と同じ仕様を書き足す |
| 運用 | 移行スクリプト (Concordia 側。dry-run が既定) | M1〜M6 |

互換性:

- 既存の `actio:<id>` 参照は変わりません。
- 既存の run は前と同じく 1 task に紐づいたままです。
- Actio が止まっている間の扱い (委託を作らずにエラーを返す) も変わりません。

## 7. 決まっていないこと (人が判断する事項)

- M1 で古い task を `cancelled` にするか、それとも `done` に合流させるか。
- M4 で `category` から決まらないタスクをどう扱うか (プロジェクト無しのまま残すか、人が振り分けるか)。

決まったこと:

- M5 は pending のうち直近のものだけを Actio に移し、残りは archive する (neco 判断 2026-10-12「おすすめで適用」)。
  直近は、taskflow の状態行の最新の更新時刻 (`updated_at`、無ければ md ファイルの git 最終コミット時刻) が
  実行日から 30 日以内 (`--legacy-recent-days` で変更可) の pending / delegated とする。直近でない pending / delegated
  とそれ以外の状態は archive する。手順の詳細は `spec/feature/task-workflow-v3.md` CC-TF-SYNC-06。
