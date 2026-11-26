---
type: feature
title: "GLab-UnityHub: GLab の Unity 開発から Discord・Breviarium・Notion・Actio・Praeforma を使う WebSocket の受け口"
service: concordia
domain:
  - glab-unity-hub
status: implemented
updated: 2026-11-26
related:
  - ./module-manifest.md
  - ./trust-boundaries.md
  - ./github-issue-workflow.md
---

# GLab-UnityHub (Concordia の拡張モジュール)

> 所属ドメイン: [`glab-unity-hub`](../domains/glab-unity-hub.domain.json)

Actio タスク: `actio:3d2e0f37-a32e-4673-bf15-a89002ca9815`。
契約の正本は親セッションの `E:/Document/Ars/.claude/work-records/2026-11-26-glab-unity-hub-contract.md`
(GLab-UnityHub 契約 v1、 neco 指示 2026-11-26)。 メッセージ形式・メソッド名・close code・HTTP 経路は
Unity 側 (UnityFoundation の別委託) と共有しているので、 この文書でも変えない。

公開手順は [docs/glab-unity-hub-publish.md](../../docs/glab-unity-hub-publish.md)。

## 価値

- **GUH-V1** GLab のメンバーは Unity エディタを離れずに Discord の会話・Breviarium の状態・Notion のタスクボード・
  スプリント・プロダクトの理解・仕様の下書きを見て、 操作できる。
- **GUH-V2** 外へ開く受け口でも、 本人が発行したトークンなしには何も読めず、 海外からの接続は記録され (既定は遮断)、
  誰の操作かが監査に残る。

## 不変条件

- **GUH-INV-1** トークンは打った本人の分だけ発行・一覧・失効できる。 他人宛て・代理発行の経路は無い (管理者でも)。
- **GUH-INV-2** 平文トークンは発行時に 1 回だけ本人へ ephemeral で見せる。 保存・ログに残すのは SHA-256 だけ。
- **GUH-INV-3** 失効・期限切れ・未知は 4401、 GLab から抜けた人と海外遮断は 4403。 失効した接続は数秒以内に切る。
- **GUH-INV-4** すべてのメソッドは本人の Discord 権限・本人担当の範囲・設定の許可リストで絞る。
- **GUH-INV-5** LLM が書いたもの (カリオペ・仕様下書き) は常に draft。 人の承認を書き足さない。

## 1. トークン (`/glab-unity-token`) — GUH-TOKEN

- サブコマンド `issue [label]` / `list` / `revoke <prefix>`。 対象ユーザーの引数は持たない。
- 受けるのは GLab の guild (`GLAB_UNITY_HUB_GUILD_ID` / `glabUnityHub.guildId`) だけ。 DM・他 guild は断る。
  登録も GLab の guild にだけ行う (`src/discord/guild-scoped-commands.ts`)。 GLab が子会社 guild でも登録・dispatch される。
- 形式 `glu_` + 32 byte 乱数 (base64url)。 既定 30 日、 1 ユーザーの有効トークンは 3 本まで。
- 保存先はモジュール所有の SQLite (`glab-unity-hub.sqlite`)。 列は hash・discord_user_id・guild_id・label・
  created_at・expires_at・last_used_at・revoked_at。 Concordia 本体の DB スキーマには足さない。
- 実装: `src/glab-unity-hub/domain/token-policy.ts`、 `application/token-service.ts`、 `adapters/sqlite-store.ts`、
  `adapters/module-store.ts`、 `src/discord/commands/glab-unity-token.ts`。

## 2. 受け口 — GUH-AUTH / GUH-GEO / GUH-LIMIT / GUH-SESSION / GUH-PORTUS

- 別プロセスの worker (`src/glab-unity-hub-worker.ts`、 Excubitor code `concordia-glab-unity-hub`)。
  HTTP / WS は Portus (`@ludiars/portus` の http / ws)。 Hono と新しい WS ライブラリは使わない。
- 待受は loopback (ポートは catalog が正本)。 外部公開は Cloudflare Tunnel の公開ホスト名 (Access なし)。
- `GET /health`、 WS `/v1/glab-unity/ws`、 `POST /v1/glab-unity/melpomene/reports`。
- 認証: `Authorization: Bearer <token>`、 無ければ接続後 5 秒以内の `{"v":1,"type":"auth","payload":{"token":"..."}}`。
  auth フレームに id があれば `{"type":"result","payload":{"authenticated":true}}` を返す (ヘッダ認証では何も送らない)。
- 海外監視: `CF-IPCountry` / `CF-Connecting-IP`。 許可国 (既定 JP) 以外は監査 + neco への Discord DM
  (同一トークン・同一国は 1 時間 1 回)。 `GLAB_UNITY_HUB_GEO_POLICY=block` (既定、 neco 裁定) なら 4403、 `monitor` なら通す。
  CF ヘッダ無し かつ 送信元が loopback 以外は拒否。 `T1` / `XX` は許可国外。 CF ヘッダ無しの loopback 接続は開発用に通す。
- 制限: フレーム 64 KiB、 トークン同時接続 2、 接続 毎分 60 要求、 投稿 (discord.messages.post / melpomene.report) 1 ユーザー毎分 10 件。
  超過は `rate_limited` (同時接続超過は error フレームのあと 1008 で閉じる)。
- 監査: 接続・認証の成否・国・IP (末尾マスク)・操作種別・結果を `glab_unity_audit` に残す。
- 実装: `domain/geo-policy.ts`、 `domain/rate-limit.ts`、 `application/authenticate.ts`、 `application/geo-guard.ts`、
  `application/hub-session.ts`、 `application/connection-registry.ts`、 `adapters/portus-loader.ts`、 `adapters/portus-server.ts`、
  `runtime.ts`。

## 3. メッセージ形式とメソッド — GUH-PROTO / GUH-METHODS

形式・エラーコード・メソッドは契約 v1 のまま (`domain/protocol.ts`、 `domain/methods.ts`、
`application/method-router.ts`、 `application/method-context.ts`)。 `event: discord.message` の data は
`messages.list` の 1 件に、 購読先を示す `channelId` を足した形。

## 2'. Discord・Breviarium・Notion — GUH-DISCORD / GUH-BREVIARIUM / GUH-NOTION

- `discord.*` は本人の権限 (`permissionsFor(member)`) で絞る。 投稿は Webhook で本人の表示名・アイコンを名乗る。
  Webhook を使えない場所と返信付きの投稿は Bot が「<表示名> (Unity):」を先頭に付ける。
  購読者へは配る直前にもう一度読めるかを確かめる。 Hub worker は Bot と同じ token で別の gateway に入り、 GLab 以外のイベントは捨てる。
- `breviarium.snapshot` は Breviarium の `GET /api/projects` / `GET /api/projects/:code/overview` をそのまま返す。
- `notion.board.*` は `glabUnityHub.notionBoards` のボードだけ。 鍵は env `CC_NOTION_TOKEN_<credentialKey>`
  (既存の Concordia の Notion 連携と同じ置き場)。 更新前にページがそのボードの data source の行かを確かめる。
- 実装: `application/discord-service.ts`、 `adapters/discord-gateway.ts`、 `adapters/breviarium-client.ts`、
  `domain/notion-board.ts`、 `adapters/notion-boards.ts`、 `adapters/service-http.ts`。

## 4a. Melpomene — GUH-MELPOMENE

- HTTP は Bearer 必須、 海外監視・レート制限は WS と同じ。 gzip 可 (展開後 ≤ 5 MiB)。 repo は `glabUnityHub.melpomeneRepos` だけ。
- ログはバグ報告チャンネル (`glabUnityHub.bugReportChannelId`) へ添付で上げ、 その URL を Issue 本文に書く。 起票は gh 認証で行い、
  Unity にトークンを持たせない。 応答 `{issueUrl, logUrls}`。 WS の `melpomene.report` はログ無し。
- 実装: `domain/melpomene-report.ts`、 `application/melpomene-service.ts`、 `application/melpomene-http.ts`、 `adapters/github-cli.ts`。

## 4b. テルプシコラ (スプリント) — GUH-SPRINT

- 正本は Actio。 既存の Actio 連携 (`CONCORDIA_ACTIO_TASK_BINDINGS` + `ActioTransport`) で
  `GET /api/projects/cc/:code/sprints` (Breviarium の cross-project-sprints と同じ集計) とスプリントのタスクを読む。
  経過率・消化率は Breviarium の `sprint-progress.ts` と同じ式。
- `sprint.tasks.update` は担当者が本人のタスクだけ (Discord → Actio ユーザーの対応は `glabUnityHub.actioUsers`)。
- 実装: `domain/sprint-view.ts`、 `application/sprint-service.ts`、 `adapters/actio-sprints.ts`。

## 4c. カリオペ — GUH-CALLIOPE

- 素材: Anatomia の business-domain-view (domain-review と同じ取得経路)、 対象リポの `spec/ux/*.md`、
  Praeforma の ux-goal、 Breviarium の overview。 取れた素材だけを使い、 出所 (sources) に載せる。
- 文章化は既存の `runAvailableText` (ツール無しの 1 回きり生成)。 出力は契約の形を検査し、 合わなければ保存しない。
- `calliope.refresh` は同一プロジェクト 1 時間 1 回 (保存済みの生成時刻も数える)、 非同期。 完了で `event: calliope.updated`。
- 実装: `domain/calliope-product.ts`、 `application/calliope-service.ts`、 `adapters/calliope-adapters.ts`。

## 4d. Praeforma の仕様下書き — GUH-SPEC

- 既存の GitHub webhook 受け口 (`src/api/github.ts`、 repo 個別 secret の署名検証) で `pull_request` を受け、
  `glabUnityHub.specRepos` の repo の opened / synchronize / reopened / ready_for_review だけをジョブに積む
  (`adapters/module-store.ts` の `enqueueGlabSpecDraft`)。 同じ PR の同じ head は 1 回。
- Hub worker がジョブを取り出し、 `gh pr diff` → Praeforma の `spec-fragments` に draft の断片 → `spec-versions/reconstructions`
  で再構築案 → PR に「仕様の下書きができた」コメント。 書き込みは Praeforma のローカルモードの Origin 規則に従う。
- `spec.list` / `spec.get` は手元の記録を Praeforma の断片の処理結果 (pending / integrated / rejected) で読み直す。
  `spec.review` は `reconstructions/:rid/decide` へ中継し、 本人の操作として記録する。
- 実装: `domain/spec-draft.ts`、 `application/spec-draft-service.ts`、 `adapters/praeforma-specs.ts`。

## 5. 構成 — GUH-ARCH

- domain (純関数ポリシー) / application (use case と ports) / adapters / runtime (組み立て) / worker (入口)。
- `src/modules/manifest.ts` の `glab-unity-hub` (worker 専用)。 `excubitor.catalog.yaml` の `concordia-glab-unity-hub` (autostart なし)。
- Portus は外部取り込みの検査記録が要るため、 この変更では package.json に足していない。 worker は起動時に
  `@ludiars/portus` → `GLAB_UNITY_HUB_PORTUS_ROOT` (ビルド済み Portus) の順で読み込み、 無ければ理由付きで止まる。

## 6. 設定 — GUH-CONFIG

- 秘密でない設定は `concordia.config.json` の `glabUnityHub` 節 (例は `concordia.config.example.json`)。
- env: `GLAB_UNITY_HUB_GUILD_ID` / `GLAB_UNITY_HUB_PORT` / `GLAB_UNITY_HUB_ALLOWED_COUNTRIES` / `GLAB_UNITY_HUB_GEO_POLICY` /
  `GLAB_UNITY_HUB_DB_PATH` / `GLAB_UNITY_HUB_PORTUS_ROOT` (`src/config/settings/definitions/glab-unity-hub.ts`)。
- 実装: `adapters/hub-config.ts`。

## 受け入れ条件 (契約書式)

- C-1 decideIssue(input): GLab の guild 以外 (DM を含む) は wrong_guild、 有効 3 本以上は limit_reached、 それ以外だけ発行できる
- C-2 hashToken(token): 平文の SHA-256 (16 進 64 文字) を返し、 平文を含まない
- C-3 evaluateGeo(input): CF ヘッダ無しかつ非 loopback は拒否、 許可国外は block で拒否・monitor で通す (T1/XX は許可国外)
- C-4 parseFrame(text): v=1 の要求だけを request とし、 auth フレームは token 必須、 それ以外は invalid を返す
- C-5 checkPayload(method, payload): 契約の上限 (limit ≤ 50・content ≤ 2000 など) を外れた payload を拒否する
- C-6 mayUpdateSprintTask(task, actor): 担当者が本人のときだけ true
- C-7 checkReport(value, allowedRepos): 許可リスト外の repo は forbidden、 形が違えば invalid_request
- C-8 pullRequestForSpecDraft(repo, payload, bindings): 対象リポの opened / synchronize / reopened / ready_for_review だけを拾う
