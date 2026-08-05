---
task: inquiry-protocol
project: Concordia
kind: 実装
status: pending
created: 2026-08-02T00:00:00.000Z
source_session: lictor-ba65b800-2ca3-44c3-80a9-1027125f8e42
memoria_task_id: 710
actio_task_id: null
memory_links:
  - spec/feature/inquiry.md
  - spec/feature/session-surface-project-codes.md
  - spec/feature/session-shutdown.md
  - spec/feature/task-workflow.md
  - spec/feature/idle-nudge.md
  - spec/feature/goal-and-go.md
---
# お伺い (inquiry) プロトコルと関連改修 — Concordia 側

## 目的

2026-08-02 neco 指示の項目 1・3・4・5・6 を Concordia に実装する。
設計正本は `spec/feature/inquiry.md` と `spec/feature/session-surface-project-codes.md`。
**設計は確定済み。 spec に書いてあることをそのまま実装する。 spec と違う設計にしない。**

Lictor 側の対応実装は別タスク (`Lictor/spec/tasks/2026-08-02-inquiry-lictor.md`)。

## 完了条件

### T1. お伺い API (`spec/feature/inquiry.md` §1-3)

- `POST /v1/inquiry` と `GET /v1/inquiry/:id` を追加する。 route 登録は
  既存の `src/api/register-core.ts` の流儀に合わせる。
- リクエスト/レスポンスの形は spec §1 のとおり。 zod でバリデーションする。
- カテゴリ語彙は spec §2 の 4 つ。 未知カテゴリは 400。
- **概念を取り違えないこと**: 「お伺い」は**人間に聞く**ことであり、 Cc が判断を
  下す仕組みではない。 Genius は人間 (neco) の判断代行としてその問いの宛先に座って
  いるだけで、 代行が答えられなければ生身の人間 (上長) に上がる。
  「Cc が Genius を使って判断する」 という実装にしない (spec §0-0)。
- 取り次ぎの手順は spec §3 のとおり。 **Cc 本体に LLM を持ち込まない**
  (task-workflow §0-4 の原則)。 Genius が落ちていたら `self_judge` に倒すだけで、
  代替の LLM 呼び出しはしない。
- Genius クライアントは `src/` 配下に独立モジュールとして切る (SRP)。
  死活確認 (`GET /healthz`, timeout 2s) と `POST /api/clone/query` の 2 本だけ。
- **`GENIUS_URL` は Excubitor catalog の `provides.GENIUS_URL` から解決する。**
  `4230` を Cc 側にハードコードしない (port-source-rule)。 catalog から取れない
  場合は Genius 不在扱い。 既存の Excubitor 解決コード (`src/excubitor/`) を再利用する。
- `session_events` に `kind: "inquiry"` で記録する。
- 同一 (session, category) の 60 秒キャッシュ (`CONCORDIA_INQUIRY_CACHE_SEC`)。

### T2. 催促通知の発火条件差し替え (`spec/feature/inquiry.md` §5)

- `src/control/idle-nudge.ts` の `shouldArmIdleNudgeFromFrame` による arm を**撤去**する。
  clear 側 (`shouldClearIdleNudgeFromFrame` / user_activity / 人間 inject / 終了) は残す。
- arm は `decision === "ask_human"` に着地した瞬間だけ行う。
- 同一セッションで `proceed` / `self_judge` に着地したら disarm する。
- 秒数は `CONCORDIA_IDLE_NUDGE_SEC` (既定 120) のまま。
- 通知先に §4 の上長を加える (既存の requester 集合 + 上長)。
- `spec/feature/idle-nudge.md` に「発火条件は inquiry.md §5 へ移譲」と追記する。

### T3. 上長 (supervisor) (`spec/feature/inquiry.md` §4)

- `delegation_runs` に `supervisor_platform` / `supervisor_user_id` 列を追加する
  (migration を既存の流儀で書く)。
- 解決順は spec §4 のとおり (run → template 既定 → config 既定)。
- `CONCORDIA_DEFAULT_SUPERVISOR` (`"discord:<uid>"` 形式) を config に追加する。
- 上長への通知はセッションの forum スレッドに 1 通メンション付きで投稿する。

### T4. 作業完了時の自動お伺い (`spec/feature/inquiry.md` §6)

- Lictor から `category: "タスク"` で届いたお伺いを処理し、
  応答の `instruction` を `session.inject` (`source: "auto:inquiry"`) で流す。
- `auto:inquiry` は requester inject では**ない** ので、 idle の clear 契機にしない
  (`parseRequesterSource` が null を返す形式にする)。

### T5. パートタイマーの自動終了を廃止 (`spec/feature/inquiry.md` §7)

- `src/taskflow/session-end.ts` の `finishAutonomousTaskflow` が撃っている
  自動 session-end inject を**お伺い送信に置き換える**。 自動終了はここで無くなる。
- 完了時は上長へ必ず完了報告メンションを出す (decision に関わらず)。
- 応答の `instruction` には「残タスクが無ければ session-end を実行する」旨を含め、
  **判断はセッション自身に委ねる** (Cc が終了を強制しない)。
- 既存テスト (`src/taskflow/session-end.test.ts`) を新しい振る舞いに合わせて書き直す。

### T6. goal-and-go の統合 (`spec/feature/inquiry.md` §8)

- `startGoalAndGo` が `createIdleNudge` で張っている idle タイマを撤去し、
  継続判断をお伺い経由にする。
- `continuation_count` / `maxContinuations` / `maxRuntimeSec` の上限は**残す**。
  上限到達後のお伺いは `ask_human` に固定する。
- `taskflow.continue_requested` 経由の継続は現行動作を維持する。

### T7. 投稿タイトルの全プロジェクトコード (`spec/feature/session-surface-project-codes.md`)

- `sessions.active_repos` (TEXT / JSON 配列) を追加し、 lifecycle で保存する。
- `ForumProjectResolver` に `codesForRepos(repoPaths: string[]): string[]` を追加する。
  解決規則は spec §2.2 の 1-4 をそのまま実装する (PROJECT-CODES に無い解決結果は捨てる /
  `Ar` は他にコードがあれば捨てる / 出現順維持 / 上限 4 + `+n`)。
- `onSessionRegistered` / `onSessionTitleChanged` / reconcile の各呼び出しを
  `projectCode: string` から `projectCodes: string[]` に変える。
- `lictor.active_repo.changed` を受けてタイトルを貼り直す経路を追加する (現状は未更新)。

## スコープ (編集可ディレクトリ)

- `E:/Document/Ars/.wt-Cc-inquiry/src/`
- `E:/Document/Ars/.wt-Cc-inquiry/spec/` (追記のみ。 §T2 の idle-nudge.md への注記など)
- `E:/Document/Ars/.wt-Cc-inquiry/tests/`

**Lictor リポは触らない** (別タスク)。

## 守ること

- **ブランチは `feat/inquiry-protocol`、 作業ディレクトリは
  `E:/Document/Ars/.wt-Cc-inquiry`。** 他のディレクトリ・ブランチで作業しない。
- SRP とファイル分割 (`/coding-conventions`)。 1 ファイルに詰め込まない。
  Genius クライアント・お伺い判定・上長解決はそれぞれ別モジュールに切る。
- 1 行圧縮コードを書かない。 既存コードの整形に合わせる。
- **サービスの起動・再起動・動作テストはしない** (ハーネス deny)。
  ユニットテストは書いてよい。
- PR 作成まで。 マージしない。
- コメントは既存コードと同じく日本語で、 「なぜそうしたか」 を書く。

## 完了報告

実装が終わったら PR を作り、 以下を報告する:

- 実装した T番号 と、 実装しなかったものがあればその理由
- 追加した migration と config 変数の一覧
- Genius 停止中に `POST /v1/inquiry` が 2 秒以内に `self_judge` を返すことを
  ユニットテスト (Genius をモック) で確認したか
