# Slack bot を動かすための設定 (slack)

## 目的

Concordia のセッション出力を Slack に流し、スレッド返信で inject、ボタンで質問回答、
slash でセッション操作する。bot は Concordia backend と **同一プロセス内**で動く
(`startBackend()` → `startSlackBotManaged()`)。設計詳細は
[`spec/feature/slack-platform.md`](../feature/slack-platform.md)。

bot は **opt-in**。`CONCORDIA_SLACK_ENABLED=1` でない限り完全 no-op で、本体や Discord
連携には一切影響しない (`src/slack/bot.ts`)。Discord と **同時起動可**(両者は独立に
eventBus を購読する)。

接続は **Socket Mode**(outbound WebSocket)。Concordia は loopback 専用で公開 inbound
URL を持てないため、Events API(Request URL 方式)ではなく Socket Mode を使う。

## 設定キー

| キー | 必須 | 意味 |
|------|------|------|
| `CONCORDIA_SLACK_ENABLED` | ◯ (`1`) | これが `1` のときだけ bot 起動。 |
| `CONCORDIA_SLACK_BOT_TOKEN` | ◯ | Bot User OAuth Token (`xoxb-…`)。Web API 呼び出し用。 |
| `CONCORDIA_SLACK_APP_TOKEN` | ◯ | App-Level Token (`xapp-…`)。Socket Mode 接続用。 |
| `CONCORDIA_SLACK_CHANNEL_ID` | ◯ | 運用チャンネル ID (`C…`)。この中で thread-per-session 多重化。 |
| `CONCORDIA_SLACK_WORKING_IDLE_SEC` | × | 「作業中」表示を消す無進捗秒数 (既定 60、最小 15)。 |

4 つの必須キーが揃わないと起動 skip (warn)(`slackEnvReady()` / `src/slack/types.ts`)。

> env は **初期 bootstrap / フォールバック** として使えるが、 **推奨はサービス内設定**(下記)。
> DB に設定された値が env より優先される。

## サービス内設定 (Web UI / API) — env を編集せず設定する

Web UI の **Slack** タブ、 または `/v1/admin/slack` API から token / channel / enabled を
設定できる。**保存した時点で bot を hot 再接続**するのでサービス再起動は不要。

- token (bot/app) は **secret-box で暗号化して DB に保存**(`slack_config` テーブル)。
  平文では持たず、 GET でも値は返さない (set 済みかだけ)。暗号鍵は DB の外に置く:
  env `CONCORDIA_SECRET_KEY`(任意の passphrase)→ 無ければ起動時に
  `concordia.secret.key`(cwd、 gitignore 済)を自動生成。
- DB 値が env より優先。 DB 側を空文字でクリアすると env にフォールバックする。

API:

| Method | Path | 用途 |
|--------|------|------|
| GET | `/v1/admin/slack/config` | redact 済み状態(`bot_token_set` 等、 値は返さない) |
| PUT | `/v1/admin/slack/config` | 設定更新 + hot 再接続。body: `{ enabled?, channel_id?, bot_token?, app_token? }`(空文字=クリア) |
| POST | `/v1/admin/slack/start` `/stop` `/restart` | bot ライフサイクル制御 |

```bash
# 例: token と channel を一括設定して即接続
curl -s -X PUT http://127.0.0.1:17330/v1/admin/slack/config \
  -H "content-type: application/json" \
  -d '{"enabled":true,"channel_id":"C0XXXXXXX","bot_token":"xoxb-...","app_token":"xapp-..."}'
```

実装: `src/api/slack-admin.ts` / `src/slack/config.ts` / `src/shared/secret-box.ts`。

## Slack App 側の設定 (api.slack.com/apps)

1. **Create New App → From scratch**(名前 + ワークスペース選択)。
2. **OAuth & Permissions → Bot Token Scopes** に付与:
   - `chat:write` — 出力投稿 / 作業中 / 質問・ボタン除去・削除 / ライブカード更新 (`chat.postMessage/update/delete`)
   - `channels:history` — 公開チャンネルの発言受信(ingress = thread 返信 → inject)
   - `reactions:read` — リアクション受信(👍=実装着手 等のリアクション制御)
   - `commands` — `/concordia` slash コマンド
   - ※プライベートチャンネル運用なら `channels:history` の代わりに `groups:history`
3. **Socket Mode → Enable**。**Basic Information → App-Level Tokens** で
   `connections:write` スコープのトークンを発行 → `xapp-…`(= `CONCORDIA_SLACK_APP_TOKEN`)。
4. **Event Subscriptions → Enable** → **Subscribe to bot events** に `message.channels`
   と `reaction_added` を追加(プライベートなら `message.groups`)。Socket Mode なので Request URL は不要。
5. **Interactivity & Shortcuts → Enable**(質問ボタン用)。Request URL は不要。
6. **Slash Commands → Create New Command** で `/concordia` を 1 個登録(Request URL 不要)。
   これ 1 個で `stat / prs / spawn / end / help` のサブコマンドを捌く。
7. **Install App** → ワークスペースにインストール → **Bot User OAuth Token `xoxb-…`**
   (= `CONCORDIA_SLACK_BOT_TOKEN`)。

### App manifest で一括作成 (上記 2/4/5/6 を一発で)

**Create New App → From an app manifest** に以下を貼ると、 scopes / slash command /
event subscription / interactivity / Socket Mode をまとめて構成できる(YAML)。

```yaml
display_information:
  name: Concordia
  description: Multi-agent session coordinator bridge
features:
  bot_user:
    display_name: Concordia
    always_online: true
  slash_commands:
    - command: /concordia
      description: Concordia session control
      usage_hint: stat | prs | spawn | end | help
      should_escape: false
    - command: /co-spawn
      description: 新規セッションを起動 (引数なしでフォーム)
      usage_hint: "[claude|codex] [cwd]"
      should_escape: false
    - command: /co-stat
      description: 全セッションの現況
      should_escape: false
    - command: /co-prs
      description: PR キュー
      should_escape: false
    - command: /co-end
      description: セッション終了
      usage_hint: "<session_id 先頭8桁>"
      should_escape: false
    - command: /co-rename
      description: セッションのやる事を変更
      usage_hint: "<session_id 先頭8桁> <新タイトル>"
      should_escape: false
    - command: /co-help
      description: Concordia slash のヘルプ
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - channels:read
      - reactions:read        # 👍=実装着手 等のリアクション制御
      - commands
      # プライベートチャンネル運用なら channels:history を groups:history に置換
settings:
  event_subscriptions:
    bot_events:
      - message.channels      # プライベートなら message.groups
      - reaction_added        # リアクション制御の入口
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

manifest で**作れないもの**は手動で残す:
- **App-Level Token** (`xapp-…`, scope `connections:write`) を Basic Information → App-Level Tokens で発行(手順 3)。
- **Install App** で `xoxb-…` を取得(手順 7)。
- bot を運用チャンネルに `/invite`。

## `/co-spawn` で委託テンプレ起動 (slash → モーダル)

**`/co-spawn`**(引数なし)で **アクティブな delegation テンプレ一覧**をモーダルに出し、
選ぶ → そのテンプレの入力欄が現れる → 「起動」で委託セッションを spawn する。
`/concordia spawn <provider> [cwd]` で毎回 provider を打つ代わりの GUI 経路。

仕組み(2 段モーダル):
1. `/co-spawn` → `/v1/delegation/templates`(active のみ)を取得 → `views.open` で
   **テンプレ select だけ**のモーダルを表示(submit ボタン無し)。
2. テンプレを選ぶと `block_actions` が届き、`views.update` で **そのテンプレの
   `input_schema` を入力欄 + 作業ディレクトリ + 「起動」**に差し替える。
3. 送信(`view_submission`)を **既存の Socket Mode 接続**で受け、`/v1/delegation/invoke`
   に `{spawn:true}` で流す。結果(`✅ 委託起動: <call_name> pid=…`)は運用チャンネルに通知。

実装は `src/slack/delegation-modal.ts`(view 組み立て/選択・送信パース、純粋)+
`src/slack/slash.ts`(`listDelegationTemplates` / `invokeDelegation`)+ `src/slack/bot.ts` の
`slash_commands` / `interactive`(`block_actions` の views.update と `view_submission`)ハンドラ。

> アクティブなテンプレが無い場合は ephemeral で案内。`/co-spawn claude [cwd]`(引数あり)は
> 従来どおり **素のセッション**を即 spawn するフォールバックとして残る。

> **Enterprise Grid も Workflow Builder も不要**。公開 URL も不要(loopback 設計のまま)。
> 無料プランでも動く(モーダルは標準機能)。

### 1. `/co-spawn` slash コマンドを登録

上の **app manifest** に `/co-spawn` を入れてある。既存アプリに後付けするなら api.slack.com/apps →
該当アプリ → **Slash Commands → Create New Command** で `/co-spawn` を 1 個追加(Request URL
不要)。**Interactivity** が Enable であること(質問ボタンと共用、既定で有効)。

追加後、 **Install App**(再インストール)で反映。コードは同梱済みなので env / 追加設定は不要、
bot を再接続(Slack タブ保存 / `/restart` / プロセス再起動)すれば有効。

### 2. 使い方

- **`/co-spawn`**(引数なし)→ フォームが開く。provider(claude / codex)を選び、 作業ディレクトリ
  (任意)を入れて「起動」。spawn 結果(pid 等)が運用チャンネルに出る。
- **`/co-spawn claude E:\Document\Ars\Cernere`** のように引数を付ければフォームを出さず即起動。
- 従来の **`/concordia spawn …`** もそのまま使える。

### トラブルシュート

- **`/co-spawn` が出てこない**: Slash Command 登録後に **再インストール**したか。
- **フォームが開かない**: **Interactivity** が Enable か。bot を再接続したか。
- **「provider は claude / codex のいずれか」**: 引数起動で provider 名が不正。`claude` / `codex` を。

### (任意) Workflow Builder のカスタムステップにもしたい場合

コードには custom function `spawn_session` のハンドラ(`socket.on("function_executed", …)`)も
同梱しており、 Workflow Builder のステップとして spawn を呼ぶことも**理屈上は**できる。ただし
カスタムステップは **Enterprise Grid でアプリを Org レベルに有効化**(org-ready + org インストール、
**Org 管理者の操作**)+ `function_executed` bot event 購読が必須で、 custom function を含む
ワークフローは**実行回数の従量課金**が乗る。手間と制約が大きいので、 通常は上記 `/co-spawn` で十分。
Grid 環境で本当に Workflow Builder ステップにしたい時だけ、 Org 管理者に Org レベル有効化を依頼し、
Functions GUI で `spawn_session`(input: provider/cwd、 output: result)を作る。

## チャンネルの用意

- 運用チャンネルを 1 つ作る(例 `#concordia`)。
- **bot をチャンネルに招待**(`/invite @<botname>`)。招待しないと発言の受信も投稿もできない。
- チャンネル ID (`C…`) を取得(チャンネル名クリック → 最下部、またはリンク末尾)。

## `.env`(`E:\Document\Ars\Concordia\.env`)

```
CONCORDIA_SLACK_ENABLED=1
CONCORDIA_SLACK_BOT_TOKEN=xoxb-...
CONCORDIA_SLACK_APP_TOKEN=xapp-...
CONCORDIA_SLACK_CHANNEL_ID=C0XXXXXXX
# 任意
CONCORDIA_SLACK_WORKING_IDLE_SEC=60
```

`.env` は `tsx --env-file-if-exists=.env` 経由で読まれる(Discord と同じ)。

## 検証

Concordia 再起動後、ログに次が出れば接続成功:

```
Slack platform connected (channel=C…, bot=U…)
```

`CONCORDIA_SLACK_ENABLED` が無ければ `CONCORDIA_SLACK_ENABLED != 1; skip` で no-op。

## 使い方

- **セッション出力**: 運用チャンネル内に session ごとの thread が立ち、AI 応答が流れる。
  作業中は thread 最下部に「🔄 作業中…」(進捗で消えて落ち着くと再掲、idle で除去)。
- **スレッド親 = ライブカード**: thread root は「使用 AI / 現在の作業内容」を表示し続け、
  作業が進むと更新される。セッション終了で `✅ Done` + サマリーポエムに差し替わる。
- **指示を送る**: そのセッションの **thread に返信** → inject。
- **👍 リアクションで指示**(`CONCORDIA_REACTION_WORKFLOW=1` の時): Concordia の投稿に
  リアクションを付けると処理が走る。👍/🆗=提案をそのまま実装着手、📝/✅=タスク登録、
  👀=メモ、😄/😡=作業メモリ記録。詳細は [`spec/feature/reaction-workflow.md`](../feature/reaction-workflow.md)。
- **チャンネル直下の発言** → `consultation` メタチャットへ。
- **質問 (AskUserQuestion)**: thread にボタンが出る → 押して回答。ローカル(端末)で
  答えた場合はボタンが自動失効(再クリックは弾かれる)。
- **slash**:
  - `/co-spawn` — 新規セッション起動(引数なしで provider/cwd フォーム、引数で即起動)
  - `/co-stat` — 全セッション現況
  - `/co-prs` — PR キュー
  - `/co-end <session_id 先頭8桁>` — セッション終了
  - `/co-rename <session_id 先頭8桁> <新タイトル>` — やる事を変更
  - `/co-help` — ヘルプ
  - 従来の `/concordia <sub>`(stat / prs / spawn / end / rename / help)も同じ動作で使える。
    `/co-<sub>` は同じサブコマンドを独立 slash に分解しただけ(`src/slack/bot.ts` で dispatch)。

## トラブルシュート

- **`… skip` で起動しない**: 4 つの必須キーのいずれか欠落。`CONCORDIA_SLACK_*` を確認。
- **発言が inject されない / 出力が出ない**: bot をチャンネルに**招待**したか、`channels:history`
  と `message.channels` イベントが有効か、`CONCORDIA_SLACK_CHANNEL_ID` が運用チャンネルと
  一致しているか。
- **質問ボタンが効かない**: **Interactivity** が Enable か。
- **`/concordia` が出てこない**: Slash Command を登録後、アプリを**再インストール**したか。
- **`auth.test failed`**: `CONCORDIA_SLACK_BOT_TOKEN`(`xoxb-`)が不正。

## まだ非対象(設計上やらない / 必要時に別途)

- per-session チャンネル自動作成(thread 方式で代替、channel 乱立回避)。
- cost / monitor / pr-queue / status-card ダッシュボードの全移植(`stat`/`prs` slash で代替)。
- slash `skill`(Lictor sidecar の port proxy が要るため。Discord も同様)。

詳細・根拠は [`spec/feature/slack-platform.md`](../feature/slack-platform.md)。
