---
id: CC-CLOUD-RUNTIME
title: Standard hosted cloud delegation runtime
status: draft
domain: cloud-execution
---

# Runtime integration

> 所属ドメイン: [`cloud-execution`](../domains/cloud-execution.domain.json)

The authorized implementation extends `/v1/delegation/cloud`, mounted by the
existing core API composition. It does not introduce another scheduler or convert
remote sessions into local Lictor children. Actio remains the task owner.

The existing loopback/admin trust boundary applies. Every operation resolves an
active parent session, its canonical repository and subsidiary, and checks the
Actio task in that scope. Journal directories are separated by that scope. Request
bodies cannot choose a filesystem path, provider executable, token or storage host.
Submission also checks the existing daily/monthly budget gate, company session
capacity and pending human-question gate. Remote consumption and cancellation are
not inferred from local session accounting; provider-side usage limits still apply.

Configuration is an operator-owned JSON file selected by
`CONCORDIA_CLOUD_CONFIG_FILE`. It contains standard hosted target identities,
published branch/revision, environment preparation evidence and secret variable
names only. Missing configuration is an explicit unavailable response. Secrets
come from existing service environment bindings, never an API response.

For the first transport implementation, support an already configured private AWS
S3 bucket. This is a code capability, not authorization to create a bucket, buy
storage, expose a service or change access policy. Each attempt has separate keys.
Signed PUT URLs expire and require `If-None-Match: *`; only those object URLs go to
the worker, never the underlying account credentials. Do not persist these URLs in
the local journal or ordinary logs. Codex receives the prompt on stdin, not argv.
The result manifest is written last. GET URLs are generated locally only when
collecting. Downloads have byte limits, timeouts and no redirects. Verify all bytes
before saving a verified marker or serving a downloadable artifact.

The UI offers configured targets, a linked task and instruction, submission,
status lookup, artifact collection and downloads. A lost response retains the
attempt ID; clicking again cannot create another attempt. A separate explicit
reconciliation operation records an observed provider ID without a resend.
Submitted, unknown and artifacts-verified remain separate from task acceptance,
review, release and actual remote cancellation. No automatic Actio completion.

Configuration and storage selection remain unanswered human setup inputs. The
Tokyo2070 trial is the live acceptance; mocks or local generation cannot replace it.
Candidate projects also include Synergos and heavy rendering in Fg/LD, subject to
all four admission conditions. Restore by disabling the cloud configuration while
preserving the journal and collected outputs; never remove intents to retry.

## 共通実行契約

日次カイゼンは本社 cron が登録した指令を起点に、登録プロジェクトに対応する Codex Cloud の
Git 単独返送ターゲットへ投入する。構成には固定の作業証拠が必要。HTTP 経路とは独立した Cc 内部呼出しで、Actio スコープ、全体予算、
本社の容量、送信意図と受付の記録、Git 回収・審査の境界を共用する。

Actio `actio:cf6b45c9-6e28-47c1-b030-7cad7d551ffa`。UX-CC-W2/W3/W4/W5、CC-INV-02/03/04/07。
cloud-execution は依頼意図・提供元の受付・観測・回収を所有する。Actio は仕事の進捗、Revisor と依頼者は品質判断を所有する。

- CC-CLOUD-EXEC-01: `submit / reconcile / observe / cancel / collect / release` は同じ依頼指紋と受付情報を使用する。前段の意図を保存し、応答喪失は同じ依頼の ID、専用名、指紋で照合する。投入と追送の再送を行わない。
- CC-CLOUD-EXEC-02: Claude routine の受付 ID は CLI 追送前に保存する。追送が未確認なら保存済み ID を表示し、受付結果は unknown のままとする。Codex は保存済み ID を使い、ID が失われた場合は範囲を限定した一覧に同一指紋の正確な名前が一意に見つかったときに照合する。対応する名前が検索結果に無ければ提供元画面で確認した ID を記録する。
- CC-CLOUD-EXEC-03: 提供元の終端、worker 申告、成果の整合性、品質検収、資源解放を別々に扱う。Codex は既存の read-only CLI 一覧を利用し、Claude で証拠が得られない終端は unknown とする。標準ホストの両経路では個別資源の解放は対象外で、停止操作は提供元 UI に委ねる。
- [一般版 Colab](cloud-work-colab.md) は本人開始入口から Excubitor の Colab 拠点へ投入する。明示設定で HQ REST + Jupyter を選べる。Codex/Claude の単発と Codex バッチは従来の適格性・返送先を維持する。
- [AWS](cloud-work-aws.md) は Excubitor の登録済み EC2 / Fargate を本人承認で実行する。標準ホストの自動選択と Codex バッチには参加しない。

- 投入の前に、参照先の Actio タスクがその範囲 (リポジトリ・子会社) に実在し、必要なら未完了であることを確かめる (`src/cloud-work/task-authorizer.ts` の `cloudTaskAuthorizer`)。標準ホスト・Colab・AWS の runtime が共有し、読めないタスクストアでは閉じる。

`POST /runs/:id/observe` は提供元の観測を明示要求する。 `POST /runs/:id/reconcile` に ID が無い場合は保存済み証拠を使用する。
復旧では旧 intent と receipt を保ち、同じ ID で状況を確認する。回収には受領時と同じ構成を使用する。
実機での受付と回収の検証は運用段階で行う。

## Claude CLI launch — 2026-11-03

Human instruction (Discord thread "opus-5-5"): add `claude --cloud`, then "CLIで統一" — the routine fire
adapter is replaced. Actio `actio:58f293ad-f2cf-4934-8b29-287a1dbde77b`.

CC-CLOUD-CLAUDE-CLI: Claude targets set `claudeExecutable` (native binary). Preflight requires the target's
checkout to be on `publishedBranch` at `sourceRevision`, because `claude --cloud` clones that branch from the
remote. Transfer capabilities (Git/Drive) are prepared first; a preparation failure launches nothing. Cc then
runs `claude --cloud <packet>` shell-free; the packet holds public task data only. Exactly one distinct
`session_`/`cse_` ID in its output is accepted, else `submission_unknown`. Private transfer instructions are
queued as one message with `claude -p --cloud <id> --output-format json` on stdin; only `{ok:true, session_id}`
matching the created ID counts as submitted. A created session whose transfer message is unconfirmed is
reported unknown for operator reconciliation; nothing is resent. The child environment drops API-key and
third-party provider variables so the claude.ai login is used. The CLI's creation output format is not
documented as a stable machine contract; the first live run must confirm the parser before relying on it.

## Claude routine creation with CLI follow-up — 2026-11-03

Live check (2026-11-03): `claude --cloud "<task>"` refuses to create a session without an interactive terminal
("--cloud requires an interactive terminal"), so CC-CLOUD-CLAUDE-CLI cannot run from the Cc service. Human
choice: create by routine, send follow-ups by CLI. Actio `actio:9f4dcd97-225f-4fa2-9f4a-e07c35441e97`.
This supersedes the creation half of CC-CLOUD-CLAUDE-CLI.

CC-CLOUD-CLAUDE-HYBRID: Claude targets set `claudeTriggerId` (`trig_...`), `claudeTokenEnv` and
`claudeExecutable` (native binary). Readiness requires the bound fire token. Transfer capabilities are prepared
first; a preparation failure fires nothing. Cc fires the routine with the public packet only; a reply with
`type: "routine_fire"` and a valid `claude_code_session_id` identifies the session, anything else is
`submission_unknown`. Private transfer instructions are then queued as one ordinary user message with
`claude -p --cloud <id> --output-format json` on stdin; only `{ok:true, session_id}` matching the ID counts as
submitted, otherwise unknown for operator reconciliation. Nothing is resent. The routine clones its own
configured repository, so the local checkout is not inspected; the published-revision check still applies.
The routine's saved prompt should tell Claude to treat the `routine-fire-payload` as its work packet and to
wait for the follow-up message before any upload or push.
