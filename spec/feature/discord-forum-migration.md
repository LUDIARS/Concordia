# Discord フォーラム移行 — Session / Test / TaskWorkflow

- Status: **approved (2026-07-13 未決4点をユーザ決定済み)**
- 起票: 2026-07-13 neco 指示
- 関連: `spec/discord-ui.md` (現行カテゴリ運用) / `spec/discord-lictor-relay.md` /
  `spec/feature/subsidiary-delegation.md`

## 目的 / 動機

1. **webhook の名前・アイコンをフル活用したい** — フォーラムスレッドへの webhook
   投稿は per-message で username / avatar を差し替えられる。 フォーラムは
   「1 フォーラム = 1 webhook」で全スレッドに投稿できるため、 現行の
   「1 セッションチャンネル = 1 webhook」(channel 15 個上限との戦い) が消える。
2. 現行のカテゴリ運用の構造的な痛みを解消する:
   - カテゴリ 50 チャンネル上限 (stale sweep で自衛中)
   - チャンネル rename レート制限 2回/10min (状態絵文字の反映遅延)
   - ended → archive カテゴリ移動のコスト。 フォーラムスレッドはネイティブに
     archive でき、 一覧性も高い
3. spawn UX の転換: 「コマンドで spawn」 → 「**フォーラムに投稿したら spawn**」。
   人間の作業依頼がそのままスレッド (= セッションの会話ログ) になる。

## 構成

### フォーラム (Cc 起動時に自動生成・キャッシュ)

| フォーラム | 用途 |
| --- | --- |
| **Session** | 人間とやりとりするセッション。 人間の新規投稿 = spawn 依頼 |
| **TaskWorkflow** | 自動タスク処理。 **[決定 3a] 1 delegation run = 1 スレッド** (run とログが 1:1、 完了で archive) |
| **Test** | open/draft PR の現在 head SHA と worktree を表すテスト候補。head 更新・PR merge/close・紐づけた worktree 消失で archive |

- `ensureDiscordLayout` を拡張し、 sessions / archive **カテゴリの自動生成を廃止**して
  2 フォーラムの ensure に統合する。 フォーラム ID は起動時に確認し
  `discord_config` (configRepo) にキャッシュ (現 layout キャッシュと同じ機構)。
- 子会社 guild も同様に 2 フォーラムを ensure する (SubsidiaryBotManager 経由で
  同じ layout コードを通す)。
- 既存の「状態」カテゴリ (cost / status-card / monitor / pr-queue) は現状維持。

### セッション = フォーラムスレッド

- `session.started` → Session フォーラムにスレッド作成。
  - **タイトル**: `[<プロジェクトコード>] <作業サマリ>` (title-suggest / current_task 由来。
    未確定時は role/agent 名)。 rename はスレッド名変更 (レート制限はあるが
    チャンネル rename より軽い。 状態は絵文字でなくタグで表現するため頻度も下がる)
  - **初回メッセージ**: セッション id / repo / branch / 状態カードへのリンク
- `session_channels` テーブルは channel_id 列にスレッド id を入れて流用する
  (`channel_kind: "channel" | "thread"` 列を追加し新旧共存)。
- egress: フォーラム親チャンネルの webhook 1 本を共有し、 `thread_id` 指定で投稿。
  `webhook-pool` は「フォーラム単位」のプールに縮退 (取得キーが session →
  forum になるだけで、 既存の eager 作成 / token 永続化はそのまま生きる)。
  username / avatar は persona 表示名 + persona アイコン (将来: personas repo に
  avatar_url を持たせる)。
- ingress: `message.channel.isThread() && parent === Session フォーラム` で
  session_channels のスレッド id 逆引き → 既存の inject 経路へ。
- ended / lost: スレッドを archive (カテゴリ移動・削除は廃止)。

Cc 起動時は Session と Test を別々の冪等 reconcile として実行する。一方の失敗で他方を
中止しない。Session は終了・喪失済みの stale open thread を閉じ、Test は DB に保存した
PR head SHA / worktree path と現在状態を比較して obsolete surface を閉じる。更新後の open PR
には新しい Test thread を作成する。起動後も `pr.changed` を Test reconcile のトリガーにし、
merge / close / head 更新を次の再起動まで残さない。重複イベントは集約し、実行中に到着した
更新には trailing reconcile を 1 回行う。
- 状態カード / cost チャンネルは従来どおり (このスコープでは触らない)。

### spawn-by-post (コマンド spawn の置き換え)

- 人間が Session フォーラムに**新規投稿** (スレッド作成) → Cc の `threadCreate`
  ハンドラが検知して:
  1. スレッドが Bot 自身の作成でないことを確認 (自作スレッドとの区別は owner id)
  2. **[決定 1c、2026-07-18 neco が 1b を上書き] タグ選択は不要**。
     `pickAvailableForumProvider()` が codex/claude の**週間 rate-limit 枠の残量**
     (codex: `fetchCodexRateLimits().usedWeekly` / claude: `fetchClaudeOAuthUsage().sevenDay.utilization`)
     を比較し、 残量が多い方 (空いている方) を選ぶ (同数 or 片方/両方取得失敗なら claude)。 codex なら
     `forum-codex-session` (model `gpt-5.6-terra`)、 claude なら `forum-claude-session`
     (model `claude-sonnet-5`) を **常に reasoning_effort=high** で invoke する
     (投稿内容による effort 分岐はしない)。 詳細: `src/discord/forum-spawn.ts`
     `FORUM_PROVIDER_PLAN` / `src/delegation/forum-provider-availability.ts`。
  3. プロジェクトコード (タイトル先頭 `[Xx]` / 本文から検出) → cwd 上書き
  4. セッション spawn (既存 delegation invoke / spawnSession を流用)
  5. **[2026-07-23 neco が旧方針を上書き] starter (ユーザーの元投稿) は編集しない**。
     親 Forum の webhook から同じ thread へセッション情報カードを別投稿し、その
     webhook message ID/token を保存する。タイトルと本文はこれまで通り
     extra_prompt として inject 済み
  6. 作成されたセッションをこのスレッドに紐付け (新規スレッドは作らない)
- **[決定 4a] 既存の `/spawn` コマンド・spawn テンプレ UI は恒久併存**。
  設定を細かくしたいケース (branch / worktree / options 指定等) のコマンド導線
  として残す。 reply-spawn (返信からの spawn 判定) はスレッド内返信 = 補足 inject
  に単純化。

### タグ (自動設定)

フォーラムタグは **フォーラム毎に事前定義 (最大 20 種)・スレッドあたり最大 5 個**
という Discord 制約があるため、 自由文字列 (ブランチ名) はタグにできない。

- **[決定 1b、2026-07-13 → 2026-07-18 に 1c で上書き] delegation テンプレタグ (最大 10 種)**:
  delegation template に `forum_tag` フラグ (boolean) を追加し、 フラグ ON のテンプレ
  (**上限 10**、 11 個目の ON は API で拒否) を Session フォーラムのタグとして生成する
  仕組み自体は残す (WebUI の一覧表示・将来の call spawn 用途)。 ただし
  **spawn-by-post はもうこのタグを読まない** — 2026-07-18 決定 1c によりタグ選択必須は
  廃止され、 provider は空き状況で自動選択する (詳細は spawn-by-post 節)。
  - **不足タグは Discord Bot 起動時の layout ensure で自動補完する。** rename / 削除で
    残った旧タグの整理は、 WebUI (delegation 設定画面) の「フォーラムタグ更新」ボタンで
    明示同期する (通常起動を空タグで詰まらせず、破壊的な整理だけ管理者確認を残す)。
- **作業内容タグ (固定 5 種)**: `設計相談` / `実装` / `レビュー` / `テスト` / `雑用`。
  title-suggest と同じ黒箱 (Haiku 責務) が current_task / 初回 prompt から分類し
  自動付与。 変更されたら貼り替え。
- **状態タグ**: active thread は `作業中` / `待機` を使う。`lost` は旧 thread 互換の
  予約タグとして残すが、現在は lost を thread archive で閉じる。
- タグ枠の割当: テンプレ 10 + 作業内容 5 + 状態 3 = 18 ≤ 20 (Discord 上限内)。
- **[決定 2a] ブランチ**: タグにせず**スレッド初回メッセージ + 状態カード**に表示し、
  ブランチ変更イベントで初回メッセージを edit する。

## 移行計画

1. **Phase 1 (両対応・完了)**: `CONCORDIA_DISCORD_FORUM_MODE=1` フラグでフォーラム
   レイアウトを有効化。 新規セッションはスレッド、 既存カテゴリのチャンネルは
   そのまま余生 (ended で archive カテゴリへ、 stale sweep で消滅)。
2. **Phase 2 (spawn-by-post・完了)**: threadCreate ハンドラ + inject。 /spawn 併存。
3. **Phase 3 (cutover・2026-07-14 実装)**: フラグ既定 ON。 カテゴリ自動生成コード撤去、
   子会社へ展開。既存 sessions/archive カテゴリは Discord 上で内容を確認して手動整理する。
   `/spawn` と spawn テンプレ UI は廃止せず恒久併存し、reply-spawn は撤去してスレッド内返信を
   既存セッションへの通常 inject に統一する。

## 実装タスク分解 (Phase 1-2)

| # | 内容 | 主なファイル |
| --- | --- | --- |
| 1 | layout: Session/TaskWorkflow フォーラム ensure + ID キャッシュ | `discord/config.ts` |
| 2 | session_channels に channel_kind 追加 (migration 冪等) | `db/discord-repo.ts` |
| 3 | session.started → スレッド作成 (forum mode 分岐) | `discord/session-channel.ts` |
| 4 | egress: フォーラム webhook + thread_id 投稿 | `discord/webhook-pool.ts` `egress.ts` |
| 5 | ingress: スレッド → session 逆引き | `discord/ingress.ts` |
| 6 | 状態遷移: タグ貼替 / ended=archive | `discord/session-channel.ts` |
| 7 | delegation template に `forum_tag` フラグ追加 (上限 10、API で拒否) | `db/delegation-repo.ts` `api/delegation.ts` |
| 8 | WebUI「フォーラムタグ更新」ボタン + タグ同期エンドポイント | `web/` `api/` `discord/config.ts` |
| 9 | spawn-by-post: threadCreate → テンプレタグ解決 → spawn + 二重 inject (タグ無しは案内返信) | `discord/` 新規 `forum-spawn.ts` |
| 10 | 作業内容タグ自動分類 (黒箱) | 既存 title-suggest 経路に相乗り |
| 11 | TaskWorkflow: delegation run → スレッド | `delegation/` + egress mirror |
| 12 | 子会社展開 | `subsidiary/manager.ts` |

## 決定事項 (2026-07-13 neco)

1. **1b**: spawn-by-post は delegation テンプレタグ必須。 テンプレに `forum_tag`
   フラグを追加 (最大 10)。不足タグは Bot 起動時に補完し、rename / 削除の整理は
   WebUI の更新ボタンで明示同期する。
2. **2a**: ブランチはスレッド初回メッセージ表示 + 変更時 edit (タグ化しない)。
3. **3a**: TaskWorkflow は 1 delegation run = 1 スレッド。
4. **4a**: `/spawn` コマンド・spawn テンプレ UI は恒久併存 (詳細設定の導線)。

## 決定事項 (2026-07-18 neco、1b を上書き)

1. **1c**: spawn-by-post のタグ必須は廃止。 投稿内容の解析ではなく **provider の
   空き状況 (codex/claude それぞれの週間 rate-limit 枠の残量が多い方)** で自動選択する。
   codex は `gpt-5.6-terra`、 claude は `claude-sonnet-5` を **常に reasoning_effort=high**
   で使う (effort は投稿内容で変えない — 固定)。
2. **[2026-07-23 neco が上書き]** starter (フォーラムスレッドの最初の投稿 =
   ユーザーの元指示) は編集せず、そのまま保持する。セッション情報カードは親 Forum の
   webhook から同じ thread へ別投稿し、返された message ID と webhook ID/token を
   session surface として永続化する。以降の repo/branch/model/effort 変更同期はその
   webhook-owned message を編集する。
