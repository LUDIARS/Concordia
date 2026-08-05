---
type: feature
title: "セッション shutdown — session-end の最後に Lictor を確実に畳む"
description: "session-end スキルの最終ステップとして Lictor へ shutdown 命令を送る。Lictor は POST /v1/shutdown を受けたらラップ中の CLI プロセスを終了させ、セッションログ (transcript JSONL + 状態ファイル) をアーカイブし、後始末が終わってから自プロセスを落とす。"
service: concordia
domain: lifecycle
tags:
  - lictor
  - session-end
  - lifecycle
  - skills
status: planned
related:
  - feature/inquiry.md
  - feature/session-process-reaper.md
  - feature/discord-lictor-relay.md
updated: 2026-08-02
---

# セッション shutdown

> 2026-08-02 neco 指示 (項目 2)。 「session-end またはセッション終了で session-end
> スキルを実行した際、 最後に Lictor へ shutdown 命令を送る。 Lictor は対応する CLI
> プロセスを kill し、 セッションログをアーカイブし、 処理完了後に Lictor 自身も落ちる。」

## 1. 現状

- `session-end` の手順は 2 系統ある:
  - Claude Code: `.claude/commands/session-end.md` (slash command)
  - provider 横断: `Lictor/src/session-end-skill.ts` の `SESSION_END_SKILL_BODY`
    (Codex CLI 等に skill として配布)
- どちらも **「ログを書いて独白して終わり」**で、 プロセスの後始末を指示していない。
  実際の停止は Cc 側の session DELETE → Lictor `POST /v1/internal/force-exit`
  → `scheduleGracefulExit` (transcript が 5 分無活動になってから kill) 任せ。
- そのため session-end 済みのセッションが**最大 5 分〜30 分居座る**。
  セッションが自分で「もう終わった」と言える経路が無いのが原因。

## 2. 追加する契約

### 2.1 `POST /v1/shutdown` (Lictor sidecar)

```jsonc
{ "reason": "session-end", "archive": true }
```

受けたら以下を **この順で** 実行する:

1. **Cc へ終了を通告** — 既存の unregister 経路を先に叩く。 これを最後にすると
   プロセスが先に消えて Cc 側に `lost` セッションが残る。
2. **ラップ中の CLI プロセスを終了** — `forceExit()` を使う。
   `/v1/internal/force-exit` の graceful 待ち (transcript 無活動 5 分) は **通さない**。
   session-end スキルの最終ステップから呼ばれる = 書き終わっている前提のため。
   ただし transcript sink の flush だけは待つ (最大 5 秒)。
3. **セッションログをアーカイブ** (`archive: true` のとき、 既定 true) — §3
4. **Lictor 自身を終了** — 1-3 の完了後に `process.exit(0)`。
   レスポンスは 4 の前に返す (`{ ok: true, archived: <path|null> }`)。

異常系:

- CLI プロセスが既に死んでいる → 2 を skip して 3 へ進む (エラーにしない)。
- アーカイブ失敗 → `archived: null` + warn ログ。 **shutdown は続行する**
  (ログ保全の失敗でプロセスが残る方が害が大きい)。
- 二重呼び出し → 2 回目以降は `{ ok: true, already: true }` を返して no-op。

### 2.2 session-end スキル / slash command の末尾に追加

`SESSION_END_SKILL_BODY` と `.claude/commands/session-end.md` の両方に、
独白 (現行の最終ステップ) の**後**に新しいステップを足す:

```
## 6. Lictor に shutdown を送る (最後・必須)

ここまで終わったら、 Lictor に終了を通告する。 これをやらないと
セッションプロセスが最大 30 分居座る。

    POST http://127.0.0.1:<LICTOR_PORT>/v1/shutdown  {"reason":"session-end"}

Lictor が CLI プロセスの停止・ログのアーカイブ・自身の終了までを行う。
応答が返ったらこのセッションでやることは無い。 追加の作業を始めない。
```

- ポートは環境変数 (`LICTOR_PORT` / 既存の sidecar ポート解決) から取る。
  **ハードコードしない** (port-source-rule)。
- 「やらないこと」節に「shutdown を送る前に新しい作業を始めない」を追記する。

## 3. アーカイブするもの

`<workspace-root>/session-logs/archive/<YYYY-MM-DD>/<session-id>/` に集める:

| 中身 | 取得元 |
|---|---|
| `transcript.jsonl.gz` | `claude-transcript-<lictorId>.txt` が指す実 JSONL (`active-repos.ts`) |
| `state/` | `active-repos-<claude-sid>.txt`, `claude-session-<lictorId>.txt`, `claude-transcript-<lictorId>.txt` |
| `meta.json` | session id / provider / persona / cwd / active repos / 開始・終了時刻 / reason |

- **元ファイルは移動ではなくコピー**する。 Claude Code / Codex 側が同じ JSONL を
  掴んだままの可能性があるため、 移動すると再開時に壊れる。
- gzip 後 100MB を超える transcript は先頭・末尾 50MB ずつに切り詰め、
  `meta.json` に `truncated: true` を書く。
- state dir の解決は `resolveActiveReposDir()` を再利用する
  (`E:` 直書き禁止の既存方針を引き継ぐ)。

## 4. Cc 側から見た挙動

- Lictor が 2.1-1 で unregister するので、 Cc のセッションは `ended` に落ちる。
- 既存の session-process-reaper が「生きているのに Cc 上 ended」を掃除する経路は
  そのまま残す (shutdown が届かなかった場合の保険)。
- パートタイマーが `feature/inquiry.md` §7 で session-end を選んだ場合も、
  最終的にここに合流する。

## 5. 受け入れ条件

1. `session-end` を実行したセッションは、 独白の後に shutdown が送られ、
   **1 分以内に** CLI プロセスと Lictor プロセスの両方が消える。
2. `session-logs/archive/<日付>/<session-id>/` に transcript と meta.json が残る。
3. Cc のセッション一覧に `lost` が残らない (`ended` になる)。
4. shutdown を 2 回叩いても 500 にならない。
5. CLI が既に死んでいるセッションでも shutdown はアーカイブまで完走する。
