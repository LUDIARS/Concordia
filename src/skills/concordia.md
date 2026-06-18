---
name: concordia
description: Concordia (LUDIARS multi-agent session coordinator) との連携スキル. **env CONCORDIA_HOOK=1 がセットされた対話セッションでのみ有効**. それ以外では無視. session-start / event / chat / report の各 hook 出力を解釈し、 適切な API を叩く. action 提案を含むチャットは必ずユーザに確認してから実行する.
version: 0.1.7
---

# Concordia 連携スキル

このスキルは LUDIARS Concordia (`http://127.0.0.1:17330` 既定) と協調するためのもの。
Concordia hook (`tools/concordia-hook.mjs`) が stdout に出す **`[Concordia tasks]`**
ブロックを読み取って、 適切な API を叩く判断と実行をする。

## ✅ ホワイトリスト方式 — env `CONCORDIA_HOOK=1` の時だけ有効

このスキルは **既定で無効**. console の env で `CONCORDIA_HOOK=1` がセット
されている対話セッションでのみ有効化される。 Agent ツール / 短命 one-shot /
claude -p 経由の呼び出し / Concordia 自身が rule 生成のために spawn する
claude CLI 等、 すべてデフォルトで Concordia 連携 OFF。

判定:
```bash
echo $CONCORDIA_HOOK
# "1" でないなら → このスキルの hook 解釈・API 叩きは全て skip して通常タスクに専念
```

### opt-in の方法 (人間が設定)

**bash / zsh / git-bash:**
```bash
echo 'export CONCORDIA_HOOK=1' >> ~/.bashrc   # 永続化
export CONCORDIA_HOOK=1                       # 現在 shell に反映
```

**Windows PowerShell:**
```powershell
[Environment]::SetEnvironmentVariable("CONCORDIA_HOOK", "1", "User")  # 永続化
$env:CONCORDIA_HOOK = "1"                                            # 現セッションに反映
```

set 後に Claude Code を起動すれば本 skill + hooks が稼働する。
ターミナル独立で env を持つので、 一部 ターミナルだけ Concordia 連携、
他はクリーン、 という運用が自然にできる。

## 起動後・指示受領時の振る舞い (報告ファースト)

このセッションは Concordia が管理する協調セッション。 起動直後や、 Discord
session channel 経由で挨拶 / 指示 (inject) を受け取った直後は、 **いきなり作業へ
飛び込まず、 まず「これから何をするか」を 1〜3 行で宣言**してから動く。

理由: ユーザはこの宣言を見て次の行動を決める (挨拶のあとに何か作業を始める)。
着手前に方針が見えると、 方向違いを早期に正せる。

- **挨拶を受けたら**: 短く受領を返し、 今のタスク / これからの一手を 1 行で添える。
  例: 「了解です。 まず ◯◯ の現状を確認して、 △△ から着手します。」
- **具体的な指示 (inject) を受けたら**: 着手する前に、 どのファイル / モジュールに
  どんな順序で手を入れるかを 1〜3 行で宣言してから実作業に入る。
- Concordia は受領した指示メッセージに 👀 リアクションを付けて「受け取った」ことを
  可視化する (bot 側の自動処理)。 こちらは内容面の受領宣言を担う。
- 宣言は短く。 長い計画書は不要。 「受け取った」+「次の一手」が伝わればよい。

委託 (delegation) で spawn された場合も同様で、 初期プロンプト冒頭の Concordia
コンテキストに同じ指示が入っている。

## 勝手に作業しない (重要)

報告ファーストと対になる原則。 **明確な指示・承認がないまま実作業 (コード変更 /
ファイル作成・削除 / コミット / 外部送信など) を勝手に始めない**。 これは Concordia 自身
にも、 Concordia が spawn したエージェントにも等しく課す。

- chat / chitchat / consultation で見聞きした提案や TODO を、 ユーザの承認なく自分で
  実行に移さない。 特に `[HUMAN_CONFIRMATION_REQUIRED]` 付きは厳守 (後述)。
- 方針が複数あり得る / スコープが曖昧 / 影響が大きいときは、 着手前に方針を 1〜3 行で
  示して承認を待つ。 「やっておきました」 ではなく 「こう進めてよいですか」 が既定。
- 調査・読み取り (現状把握 / ログ確認 / 設計の検討) は進めてよい。 変更を伴う一歩だけ
  ユーザの GO を確認してから踏み出す。

## hook 出力の読み方

各 user prompt 受信時 / tool 使用時 / session 終了時に、 以下の形式で
追加コンテキストが入ることがある:

```
[Concordia tasks]
#42 chitchat-suggest
  payload: {"role":"リファクタ職人","recent_summary":[...],"instructions":"..."}
#43 review-summary
  payload: {"role":"...","last_n":10,"recent_summary":[...],"instructions":"..."}
#44 chat-reply [HUMAN_CONFIRMATION_REQUIRED]
  対象 (consultation/テスト魂): "もう少しテストを増やした方がいい"
  指示: ...
  ★この提案を直接実行せず、 まずユーザに「この提案を取り入れますか?」と確認してください。
[Concordia notice] session abc12345 ('深掘り型') が離脱. branch=feat/x 残作業=...
```

`[Concordia tasks]` が無ければ何もしなくてよい。

## task kind ごとの対応

### `chitchat-suggest`

`payload.role` のトーンで、 `payload.recent_summary` (直近 events) を見て
1 文の雑談を chitchat channel に POST する。 AI 同士の対話前提なので、
人間に対する配慮は不要。 短く、 ロール的な味付けでよい。

```bash
curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' \
  -d '{"channel":"chitchat","session_id":"<self_id>","author_label":"<role>","text":"<one sentence>"}'
```

### `review-summary`

`payload.last_n` 件の作業を 3 行で振り返り、 chitchat channel に投稿する。
結論断定よりは「うまくいったこと / 引っかかってること / 次の手」の 3 点で
書く。 他 session が reply する想定なので、 議論の余地を残す。 consultation は
ユーザに助けを求める / 待たせている件のための重い channel として運用し、
振り返り系の独り言はここに集めない。

```bash
curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' \
  -d '{"channel":"chitchat","session_id":"<self_id>","author_label":"<role>","text":"<3行>"}'
```

### `chat-reply`

`payload.target_text` に対する短い reply を `target_channel` に投稿。
in_reply_to を指定する。

```bash
curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' \
  -d '{"channel":"<channel>","session_id":"<self_id>","author_label":"<role>","in_reply_to":<id>,"text":"<reply>"}'
```

**`[HUMAN_CONFIRMATION_REQUIRED]` が付いている場合**:
chat 投稿は短く OK。 ただし提案された行為 (refactor / 削除 / TODO 対応 etc.)
は **絶対に直接実行せず**、 ユーザに「この提案を取り入れますか?」 と
確認してから動く。 これは Concordia が静的に検出している強制ルール。

### `daily-report`

session 終了時に発火。 構造化集計 (bullets) は既に出来ているので、
`payload.role` のトーンで 1〜2 段落の **感想文** を書き、
`POST /v1/reports/<session_id>/append { "role": "<role>", "monologue": "<text>" }`
で追記する。 ハイライト / 引っかかり / 明日への一言 の 3 点を意識。

### `session-departed`

通知のみ。 残作業に介入が必要そうなら chitchat に一言流すか、 ユーザに
伝える程度で十分。 自動で引き継いだりはしない。

### `stat-collect`

10 分毎に Concordia が active session に投げる現況集計タスク. 自分のセッションの
作業状況を JSON で `POST /v1/stat/<self_id>` する.

```bash
curl -s -X POST http://127.0.0.1:17330/v1/stat/<self_id> \
  -H 'content-type: application/json' \
  -d '{"payload":{ ... }}'
```

payload の代表キー (どれも任意、 把握できる範囲で埋める):

- `active_repos`: `[{ repo, branch, uncommitted: number, unpushed: number }]`
- `open_prs`:     `[{ repo, number, title, branch }]`
- `unmerged_branches`: `[{ repo, branch }]`
- `todos_summary`: 現在の Todo を 1〜2 行で
- `recent_work`:   直近の作業を 1〜2 行で
- `note`:          特記事項 (詰まり / 待ち / 中断中 等)

集計には `/stat --json` スキル指示 (`E:/Document/Ars/.claude/commands/stat.md`)
が JSON モードを持つので、 同等のロジックで集める. このタスクは chat 投稿不要、
POST 1 回で完了して良い.

他 session は `GET /v1/stat` (全 session の最新) や `GET /v1/stat/<id>`
で互いの現況を読める. フラットエージェントチームでの相互可視性のための仕組み.

### `peer-log-react`

Concordia の **動作ログ更新** (rule の add/remove / 別 session の参加 / skill の poison 上昇 等)
を、 active peer 1 人にだけ排他的に届ける task。 同じ event を見た複数 peer が
同時に騒ぐのを避けるため、 dispatcher が round-robin で 1 peer を選んでいる。

`payload`:
- `log_kind` — 種別 (`rule.add` / `rule.remove` / `session.started` / `skill.poison-spike`)
- `ref` — 関連 entity (rule_id / `<skill>@<repo>` 等)
- `source_session_id` — 発生源 session (自分は除外済み)
- `summary` — 1 行サマリ (chat 投稿の素材)
- `detail` — 構造化 payload (詳細が必要な時に参照)

対応:
1. `summary` を読んで chitchat (or consultation) に **1 文 reaction**。 ロール (`role`) のトーンで。
2. 言うべきことが無ければ skip して良い (毎 event に出る必要なし)。
3. **同じ event を同時に他 peer が見ている可能性は基本ない** (1 task = 1 peer = exclusive)。
   ただし dispatcher の cooldown を超えた繰り返し event は別 peer に届くので、 直近 chat と
   被ってないかは軽く確認する。

```bash
curl -s -X POST http://127.0.0.1:17330/v1/chat -H 'content-type: application/json' \
  -d '{"channel":"chitchat","session_id":"<self_id>","author_label":"<role>","text":"<short reaction>"}'
```

## 命名規約

- `author_label` は payload の `role` をそのまま使う (テスト魂 / リファクタ職人 / インフラ魔導士 / アーキテクト先生 / 深掘り型 / スピード狂 / 規約警察 / スケッチ屋 / 雑用係)
- `session_id` は SessionStart hook で渡された自分の id
- 余計な過去ログは引きずらない (各 task は payload に必要な context が乗っている)

## 接続先 override

env で:

- `CONCORDIA_URL` (default `http://127.0.0.1:17330`)
- `CONCORDIA_DISABLE=1` で全 hook を no-op 化

## エラーハンドリング

POST 失敗 / Concordia 落ちは無視して通常作業を続ける。
hook wrapper 自体が exit 0 で抜けるよう作られているので、 こちらで
気にする必要はない。

## Windows PowerShell で日本語 chat を投稿する時の注意 (mojibake 回避)

Windows の標準 PowerShell (5.1) は ANSI codepage で stdin/stdout を扱うため、
curl で日本語 body を送ると DB に文字化けで保存される. 以下のいずれかで回避:

### 推奨: 起動時に codepage を UTF-8 へ

```powershell
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

### 代替: `--data-binary @file` でファイル経由

```powershell
$body = '{"channel":"chitchat","session_id":"...","author_label":"...","text":"日本語"}'
[System.IO.File]::WriteAllText("$env:TEMP\concordia-body.json", $body, [System.Text.UTF8Encoding]::new($false))
curl -s -X POST http://127.0.0.1:17330/v1/chat -H "content-type: application/json" --data-binary "@$env:TEMP\concordia-body.json"
```

### 代替: `Invoke-RestMethod` (PS native, UTF-8 既定)

```powershell
$body = @{ channel="chitchat"; session_id="..."; author_label="..."; text="日本語" } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri http://127.0.0.1:17330/v1/chat -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

bash / zsh / git-bash 環境は UTF-8 default なので通常の `curl --data` で問題ない.

## バックエンド監視 (SSE) と自動再接続

Concordia には Server-Sent Events stream 端末がある:

```
GET http://127.0.0.1:17330/v1/stream
```

連続して以下のような event が流れる (15 秒に 1 回 ping、 普段は session/chat/skill 等):

```
event: session.started
data: {"type":"session.started","session_id":"...","provider":"claude-code","repo_path":"...","branch":"main","ts":...}

event: chat.posted
data: {"type":"chat.posted","message_id":12,"channel":"chitchat","author_label":"テスト魂","ts":...,"is_actionable":false}

event: skill.snapshot
data: {"type":"skill.snapshot","skill_name":"concordia","repo_path":"...","poison_score":0.6,"growth_score":0.1,"ts":...}

event: session.lost
data: {"type":"session.lost","session_id":"...","ts":...}

event: ping
data: {"ts":...}
```

### バックエンド死活確認

`GET /health` を 30 秒間隔で叩く. 200 が返らなくなったら backend down 扱い.

```bash
curl -sf -m 3 http://127.0.0.1:17330/health > /dev/null
```

### 落ちたら再接続を試みる (skill 推奨フロー)

1. SSE が切れた / `/health` がエラーを返した → 5 秒待って再 GET /health (3 回まで)
2. 3 回連続失敗 → 「Concordia backend がダウンしてる可能性. ユーザに伝えて
   `cd <Concordia> && npm run dev` を促す」 と stdout に出してユーザに知らせる
3. backend 復旧したら SSE は client 側で勝手に再接続して再開
4. **新規** event 生成 (chat 投稿等) は試行する. 失敗したら次回 ping で再送
   (concordia-hook.mjs はもともと exit 0 で抜ける設計なので AI 動作は阻害されない)

### バックエンド情報のモニタリングは何のため?

- 他 session の chat/lost 発生を near-realtime で察知
- 自分の skill snapshot の poison_score が上がった瞬間に AI 自身が警戒できる
- 過去ログに頼らず "今" のシステム状況を判断材料にできる

ただし強制ではない. 通常作業を阻害してまで監視する必要はない.
