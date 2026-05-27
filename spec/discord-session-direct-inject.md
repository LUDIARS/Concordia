# Discord session channel 直接 inject — 仕様 (PR-B 後の小機能)

## Context

PR-A 時点では session channel での投稿は「`/inject` slash command を使ってください」 と案内 reply するだけ。 PR-B で `/inject` が動くようになっても、 **毎回 slash を打つのは面倒**。 session channel で普通にメッセージを打ったら、 それをそのまま `/v1/sessions/:id/inject` に流したい。

**前提**: 並行作業中の PR-B (slash command / Modal / AskUserQuestion bridge) が main にマージされた後に着手する。

## 仕様

`src/discord/ingress.ts` の `handleMessage` を以下のように改修:

```ts
// 既存: session channel での投稿は案内 reply のみ
//
// 改修後: session channel での投稿は「コントロール」 等の特殊キーワード以外は
//          /v1/sessions/:id/inject に流す
const sessionRow = deps.sessionChannelsRepo.findByChannelId(channelId);
if (sessionRow) {
  // 「コントロール」 など special keyword は別ハンドラに先んじて拾う (control.ts)
  if (msg.content.trim() === "コントロール") return; // control panel が出る (別仕様)

  // それ以外は inject
  if (sessionRow.status !== "active") {
    await msg.reply({
      content: `このセッションは ${sessionRow.status} 状態です。 inject はできません。`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }
  const res = await fetch(`${concordiaUrl}/v1/sessions/${sessionRow.session_id}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: msg.content.slice(0, 4000),   // schema 上限
      source: `discord:${msg.author.id}`,
    }),
  });
  if (!res.ok) {
    await msg.reply({ content: `inject 失敗 (${res.status})`, allowedMentions: { repliedUser: false } });
    return;
  }
  // 成功時は reply しない (チャット流れがスッキリ)。 または ✅ リアクションを付ける:
  try { await msg.react("✅"); } catch { /* ignore */ }
  return;
}
```

## 「inject せず chat にする」 を区別したい場合

session channel での投稿は **基本 inject**。 ただし以下は例外:
- bot 自身の投稿 (= `author.bot`)
- メッセージ本文が `コントロール` (control panel 表示)
- 先頭が `//` のコメント (= 人間メモ、 inject しない)
- メンション (`@bot`) を含むコマンド系 (= 後続拡張で予約)

`//` 先頭は **inject しない & 何も返さない** (sticky note としてチャンネルに残る)。

## 削除しない原則の維持

inject 成功でも失敗でも、 ユーザのメッセージは削除しない。 ✅/❌ リアクションでフィードバック。

## エラー時の挙動

- session が lost / ended → reply で状態を伝える (削除しない)
- inject API が 4xx/5xx → reply で status 表示
- network エラー → reply に「ネットワークエラー」

## kill switch

`isChatMuted()` ON → silent ignore (= 何もしない、 log warn のみ)。 ユーザに「mute 中」 と返事すると鬱陶しいので無視で OK。

## meta channel との切り分け

| Channel 種別 | 投稿時の動作 |
|---|---|
| #chitchat / #consultation / #houkoku / #system | `POST /v1/chat` (PR-A の現行動作) |
| Session channel (`🟢-s-...`) | **新挙動: inject** |
| `コントロール` 発言 | Control Panel 投稿 (どこでも) |
| `//` で始まる行 | inject しない (sticky note) |

`ingress.ts` の優先順位:
1. bot 自身 → return
2. content === `コントロール` → control panel
3. content.startsWith(`//`) → ignore
4. session channel か? → inject
5. meta channel か? → chat

## 完了基準

- [ ] session channel で平文メッセージを打つと wt タブの pty に流れる
- [ ] `//foo` で始めると無視される (reaction も付かない)
- [ ] session が ended の channel に投稿しても安全 (案内 reply)
- [ ] meta channel の chat 投稿挙動は変わらない
- [ ] ingress.test.ts に 4 ケース追加

## 関連 spec

- [discord-ui.md](discord-ui.md) — PR-A 基盤
- [discord-ui-pr-b.md](discord-ui-pr-b.md) — PR-B (slash / AskUserQuestion bridge)
- [discord-control-ui.md](discord-control-ui.md) — 「コントロール」 発言で Control Panel
