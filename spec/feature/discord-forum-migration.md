# Discord フォーラム移行 — Session / TaskWorkflow

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
- ended: スレッドを archive (カテゴリ移動・削除は廃止)。 lost: タグで表現。
- 状態カード / cost チャンネルは従来どおり (このスコープでは触らない)。

### spawn-by-post (コマンド spawn の置き換え)

- 人間が Session フォーラムに**新規投稿** (スレッド作成) → Cc の `threadCreate`
  ハンドラが検知して:
  1. スレッドが Bot 自身の作成でないことを確認 (自作スレッドとの区別は owner id)
  2. **[決定 1b] delegation テンプレ由来のタグが付いていることを必須とする**。
     タグ無しの投稿は spawn せず、 案内メッセージ (タグを付けて再投稿) を返す。
     provider / model / 既定 cwd はタグ = テンプレから解決する
  3. プロジェクトコード (タイトル先頭 `[Xx]` / 本文から検出) → cwd 上書き
  4. セッション spawn (既存 delegation invoke / spawnSession を流用)
  5. **タイトルと本文の両方を inject** (作業サマリ + 作業内容)
  6. 作成されたセッションをこのスレッドに紐付け (新規スレッドは作らない)
- **[決定 4a] 既存の `/spawn` コマンド・spawn テンプレ UI は恒久併存**。
  設定を細かくしたいケース (branch / worktree / options 指定等) のコマンド導線
  として残す。 reply-spawn (返信からの spawn 判定) はスレッド内返信 = 補足 inject
  に単純化。

### タグ (自動設定)

フォーラムタグは **フォーラム毎に事前定義 (最大 20 種)・スレッドあたり最大 5 個**
という Discord 制約があるため、 自由文字列 (ブランチ名) はタグにできない。

- **[決定 1b] delegation テンプレタグ (最大 10 種)**: delegation template に
  `forum_tag` フラグ (boolean) を追加し、 フラグ ON のテンプレ (**上限 10**、
  11 個目の ON は API で拒否) を Session フォーラムのタグとして生成する。
  spawn-by-post はこのタグで起動テンプレを指定する (必須)。
  - **タグの Discord 反映はテンプレ更新と自動連動させず、 WebUI (delegation
    設定画面) の「フォーラムタグ更新」ボタン経由で同期する** (レート制限と
    誤爆防止のため人間の明示操作で反映)。
- **作業内容タグ (固定 5 種)**: `設計相談` / `実装` / `レビュー` / `テスト` / `雑用`。
  title-suggest と同じ黒箱 (Haiku 責務) が current_task / 初回 prompt から分類し
  自動付与。 変更されたら貼り替え。
- **状態タグ**: `作業中` / `待機` / `lost` (旧チャンネル名絵文字の代替)。
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
   フラグを追加 (最大 10)、 Discord への反映は WebUI の更新ボタン経由。
2. **2a**: ブランチはスレッド初回メッセージ表示 + 変更時 edit (タグ化しない)。
3. **3a**: TaskWorkflow は 1 delegation run = 1 スレッド。
4. **4a**: `/spawn` コマンド・spawn テンプレ UI は恒久併存 (詳細設定の導線)。
