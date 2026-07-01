---
type: feature
title: "Discord コントロール UI — 仕様 (codex / 並行 session 向け)"
description: "Discord チャンネルで「コントロール」と発言すると Control Panel embed + ボタンを投稿し、セッションの新規起動・終了・rename を GUI 操作できる補助 UI。Claude / Codex / Gemini の spawn、セッション終了確認フロー、embed 更新を Button + Modal + StringSelectMenu で実装する。"
service: concordia
domain: chat-platforms
tags:
  - discord
  - typescript
  - spawn
  - lifecycle
  - delegation
  - webhook
  - claude
  - codex
status: planned
related:
  - ../feature/discord-ui.md
  - ../feature/discord-ui-pr-b.md
updated: 2026-06-30
---


# Discord コントロール UI — 仕様 (codex / 並行 session 向け)

PR-B (Slash Command 等) と独立した追加機能。 PR-B に積むか別 PR にするかは codex 判断で OK。

## 概要

ユーザが Discord の任意 channel で **`コントロール`** とだけ発言すると、 bot がその場で **Control Panel embed + ボタン** を投稿する。 ユーザはボタン経由でセッション操作を行える。 Slash command で全部やれるが、 「ボタンを押すだけ」 の UX が欲しい人向けの補助手段。

## トリガー

`ingress.ts` の MessageCreate ハンドラで、 メッセージ本文が **正確に「コントロール」 (前後 trim 後の等価比較)** のときに発火。 別表記の同義語 (例: `/control`、 `control`、 `コンパネ`) も拾うかは codex 判断、 最小は `コントロール` 1 種で OK。

`author.bot` の場合は無視 (= ループ防止)。 session channel でも meta channel でも同様に動作。

## 投稿される Control Panel

`channel.send` 直 (webhook 不使用、 ephemeral でなく **常設投稿**)。 ユーザがピン留めしたければできるよう削除はしない。

### Embed

```
title:       🎛 Concordia コントロール
description: ボタンでセッションを起動 / 終了 / rename できます
color:       0x5865F2 (Discord blurple)
fields:
  - name:    現在 active なセッション
    value:   • 境野 詰 (テスト魂) — #🟢-s-bdea-... (15:42 active)
             • 淵渡 一 (深掘り型) — #🟢-s-c7df-... (15:50 active)
             … (active session を listSessions で 5 件まで列挙)
  - name:    操作
    value:   下のボタンから選んでください
footer:      Concordia / version: <commit hash>
```

### Action Row 1 — 新規セッション

| Button | label | style | custom_id |
|---|---|---|---|
| 1 | 🆕 Claude | Primary | `ctrl:spawn:claude` |
| 2 | 🆕 Codex | Primary | `ctrl:spawn:codex` |
| 3 | 🆕 Gemini | Primary | `ctrl:spawn:gemini` |

押下 → **Modal を開く** (TextInput: `cwd` (required, 直近の repo_path から autocomplete 不可なので placeholder で例示)、 オプション `args` (string, optional))。 submit → loopback `/v1/spawn` (Bearer は `.spawn.token`)。

### Action Row 2 — 既存セッション操作

| Button | label | style | custom_id |
|---|---|---|---|
| 1 | 🛑 セッション終了 | Danger | `ctrl:end-session` |
| 2 | ✏️ rename | Secondary | `ctrl:rename` |
| 3 | 🔄 更新 | Secondary | `ctrl:refresh` |

#### 🛑 セッション終了

押下 → **StringSelectMenu** を ephemeral で出す (`interaction.reply({ ephemeral: true, components: [...] })`):
- placeholder: `終了するセッションを選んでください`
- options: active session を最大 25 件 (label = `境野 詰 (テスト魂) — s-bdea`、 value = session_id)

選択 → **確認 Button** を 1 段重ねて出す (custom_id = `ctrl:end-session:confirm:<session_id>`、 style: Danger)。 押下 → `DELETE /v1/sessions/:id` を loopback → 既存 `end-session-flow` が走る (report 生成 + 独白 + channel ⚪ + archive 移動)。

#### ✏️ rename

押下 → **StringSelectMenu** で session 選択 → 確定 → **Modal**:
- TextInput `title` (required, max 30 chars)
- submit → loopback `POST /v1/sessions/:id/title-suggestion { text }` → Concordia が Lictor の `/v1/rename` に転送

#### 🔄 更新

押下 → 現在の embed を最新の active sessions で再生成 (`interaction.update({ embeds })`)。 Control Panel メッセージ自体は残したまま中身だけ更新。

## interaction routing (実装)

PR-B の `commands.ts:dispatchInteraction` を拡張、 もしくは新規 `src/discord/control.ts` を追加:

```ts
if (interaction.isButton() || interaction.isStringSelectMenu()) {
  const id = interaction.customId;
  if (id.startsWith("ctrl:")) {
    await handleControlInteraction(interaction, deps);
    return;
  }
  if (id.startsWith("q:")) {
    await handleQuestionInteraction(interaction, deps);  // PR-B の AskUserQuestion bridge
    return;
  }
}
if (interaction.isModalSubmit() && interaction.customId.startsWith("ctrl:")) {
  await handleControlModalSubmit(interaction, deps);
}
```

`handleControlInteraction`:
- `ctrl:spawn:<provider>` → Modal を出す
- `ctrl:end-session` → StringSelectMenu を ephemeral 表示
- `ctrl:end-session:confirm:<sid>` → DELETE /v1/sessions/:sid
- `ctrl:rename` → StringSelectMenu → Modal
- `ctrl:rename:<sid>` → Modal を出す
- `ctrl:refresh` → embed 再生成

## ingress.ts への追加

既存の MessageCreate ハンドラに、 chat 投稿フローの前段に以下を追加:

```ts
if (msg.content.trim() === "コントロール") {
  await postControlPanel(msg.channel, deps);
  return; // chat には流さない
}
```

`postControlPanel` は `src/discord/control.ts` 内:
- active sessions を listSessions で取得
- embed + 2 action row を構築
- `msg.channel.send({ embeds, components })`

## DB / 永続化

新規 table 不要。 Control Panel メッセージは永続化せず、 ユーザが「コントロール」 と打つたびに新規投稿される (= 過去のは流れていく)。 ピン留めは手動。

active sessions の取得は `SessionsRepo.listSessions({ status: "active" })` を再利用。

## 削除しない原則

Control Panel メッセージは bot が delete しない。 古いものはユーザが手動で消すか、 流れて見えなくなるだけ。 button が押せなくなった (= active session が ended になった等) ときは `interaction.reply({ ephemeral: true, content: "このセッションは既に終了しています" })` で柔らかく弾く。

## kill switch

`isChatMuted()` ON → コントロール UI 送信も停止 (Control Panel の embed は egress 経由)。 ただしユーザの「コントロール」 メッセージ自体は届くので、 stderr に warn log を残して silent ignore (= ピリピリしない)。

## アクセス制御

PR-A 時点では Discord 側の channel 権限のみで制御 (= 招待された人は全員操作可能)。 admin 限定にする場合は `discord_config` に `admin_role_id` を持って Member ロールで判定。 今回は MVP として全員可。

## 完了基準

- [ ] meta / session channel どちらでも「コントロール」 と発言で Control Panel が出る
- [ ] 🆕 Claude/Codex/Gemini ボタンで Modal → spawn が走る
- [ ] 🛑 セッション終了 → select → confirm で DELETE が走り、 channel が ⚪ archive へ移動
- [ ] ✏️ rename → select → Modal で title-suggestion 発火 (Lictor 連携で wt タイトル更新)
- [ ] 🔄 更新 で embed が active sessions 最新に更新される
- [ ] `npm run lint` clean、 `npm test` pass
- [ ] interaction custom_id の正規表現テスト (`control.test.ts`)

## 関連 spec

- [discord-ui.md](discord-ui.md) — PR-A 基盤
- [discord-ui-pr-b.md](discord-ui-pr-b.md) — Slash command + AskUserQuestion bridge (本仕様と並走、 同じ interaction dispatcher を使う)
