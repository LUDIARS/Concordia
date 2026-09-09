# 子会社 Astra の対話セッションが初回回答で終了する

- Date: 2026-09-09
- Status: unresolved — 原因特定、修正未実施
- Area: Cc forum spawn / Lictor Codex transport / session lifecycle
- Severity: 高。追加質問・確認回答・実装継続の窓口が閉じる。
- Scope: 原因調査のみ。テスト、ビルド、サービス操作、マージは実施していない。
- UX: UX-CC-W2（同一依頼を継続・再開できる）、UX-CC-W3（終了と成果を区別する）。

## Summary

neco から「子会社の Astra セッションがすぐ終わる」と報告された。
Cc はフォーラムを対話窓口として起動するが、初期依頼文を一回実行の委託用環境変数
`CONCORDIA_DELEGATION_PROMPT_FILE` で渡している。Lictor はその有無を実行モードの
判定に使うため、最初の Codex ターンが正常完了するとセッション全体を終了する。
2026-09-02 の「フォーラムを一問一答の委託にしない」という意図が下流まで成立していない回帰。
Astra モデル固有の時間制限ではない。

## Evidence

Cc の SQLite を readonly 接続で照会。日時は JST、session/transcript の ts は秒。
SymphonyKillChord 子会社の Astra 5件中、次の4件で App Server ターン完了を確認した。
残り1件（2026-09-07 21:54:56 開始、433秒）は同じ完了フレームがなく、同原因とは断定しない。

| Session ID | 開始 | 継続時間 | 最終ターン |
|---|---|---:|---|
| lictor-e60df588-7dd8-4c98-98d2-2e7de84bc288 | 09-09 13:36:14 | 145秒 | completed / error=null |
| lictor-e997de3f-86bc-446e-901e-666c3aa3e9d5 | 09-09 10:47:28 | 220秒 | completed / error=null |
| lictor-4fae47f2-1502-4312-9905-69b41cf25b66 | 09-08 18:13:54 | 238秒 | completed / error=null |
| lictor-d84ae4e7-da1f-4c12-a712-5245cf335857 | 09-08 06:42:26 | 191秒 | completed / error=null |

全4件で最終 `codex_turn_completed` の0〜1秒後に sessions が ended になった。
最新例は 2026-09-09 13:38:39 に以下を記録している。

```json
{"type":"codex_turn_completed","status":"completed","error":null}
{"text":"$session-end","source":"auto:session-end","reason":"auto on DELETE /v1/sessions/:id"}
{"duration_sec":145}
```

同例の最終回答は実装完了ではなく、worktree 作成時の Git refs 書込み拒否で着手できない旨。
別例は設計レビューの報告、別例はレビュー対象の特定待ちだった。回答の業務上の意味に
関係なく、ターン完了で窓口が閉じている。`delegation_runs` にはこの4件はなく、
metadata の `delegation_call_name=spawn` と子会社IDで特定した通常 Session 起動。

本体ログ `E:/Document/Ars/logs/concordia/cc-live.jsonl` には最新例の終了後にも
同じ Discord スレッドへの入力が `status=ended` として記録されている。

## Regression Context

- Cc `src/discord/forum-spawn.ts:462` 付近には、2026-09-02 neco 指示として
  「delegation 経由だと一問一答で即 session-end」「素のセッション起動 + startup inject」
  と明記されている。
- フォーラム側は `/v1/admin/spawn-session` を使い `prompt` を渡す。
  しかし provider 直指定・テンプレート指定の両経路とも、下流で委託用 prompt 環境変数を設定する。
- 直指定経路の環境変数設定行は git blame で `1ad70afa2`（2026-07-17）に由来する。
  Astra 導入が最初に問題を発生させたとまでは確認していない。

## Cause

1. Cc `src/discord/forum-spawn.ts:467` 付近: フォーラム本文を初期 prompt として通常 spawn に送る。
2. Cc `src/api/register-core.ts:961` 付近: adHocPrompt を保存し、
   `spawnEnv.CONCORDIA_DELEGATION_PROMPT_FILE` に設定する。テンプレ経路も同ファイル914行付近で設定する。
3. Lictor `src/wrap.ts:99` 付近: `resolveCodexTransport(env, hasDelegationPrompt)` が
   prompt ありを App Server の委託モードと判定する。
4. Lictor `src/wrap.ts:725` 付近: `runCodexDelegationTurn` を一回 await した後、
   App Server を閉じ、finally で `unregisterConcordiaSession` を呼び、return する。
5. Lictor `src/concordia.ts:66` 付近: unregister が Cc の Session DELETE を呼ぶ。
6. Cc `src/control/end-session-command.ts:65` 付近: DELETE を受けて `$session-end` を
   注入し、session を ended にする。したがって `$session-end` は最初の原因ではなく、終了後処理。

Cc の `dist/api/register-core.js` にも該当設定を確認した。
PATH 上の Lictor は `@ludiars/lictor` junction 経由で `E:/Document/Ars/Lictor` を参照し、
その `dist/wrap.js` にも同じ一回実行後の unregister を確認した。
記録された App Server フレームと配布コードの両方が上記経路を裏付ける。

### 作業を早期に止める関連問題

Lictor `src/codex-app-server-session.ts` の `turn/start` は
`approvalPolicy: "never"`、`workspaceWrite`、`writableRoots: [cwd]`、
`networkAccess: false` を固定指定している。
最新例ではエージェントが Git refs の Permission denied を報告した。
この固定ポリシーは隔離 worktree 作成の権限要求・回復を妨げるが、OS ACL まで
調査しておらず、Permission denied の全原因を特定したとは扱わない。
権限を広げることだけでは、ターン完了後のセッション終了は直らない。

## Fix Requirements

- 初期 prompt の配送と実行モードを分離する。prompt があるだけで一回実行としない。
- フォーラム／通常 spawn は、最初の回答・質問・作業停止報告の後も追加入力を受け付ける。
- 真の delegation run は従来の完了契約を維持する。単に全 App Server を常駐化しない。
- provider 直指定・テンプレ指定の両方で同じ契約を保証する。
- 初期依頼を欠落・重複させず、明示終了時のみ正しい所有者が session を終了する。
- 権限契約を通常対話と一回実行で区別し、既存のプロジェクト分離・承認境界を維持する。
- 影響確認は Astra に限定せず、同じ Codex 起動経路に及ぼす。

## Verification

実施: SQLite readonly 照会、既存ログ、Cc/Lictor のソース・配布コード・git履歴の静的確認。
テスト・ビルド・起動・再起動はユーザー指示により未実施。

修正時に必要な検証（未実施）:

1. prompt 付き通常 spawn を直指定・テンプレ指定で起動し、初回回答後も active である。
2. 確認待ち／権限不足を返しても終了せず、次の人間入力を同一 Session で処理できる。
3. 初期 prompt を一度だけ処理する。
4. 真の一回実行 delegation の完了・失敗・取消・明示終了を維持する。
5. プロジェクト範囲外アクセスを許可せず、認可された worktree 作成の扱いを検証する。

## Follow-up

今回の成果は原因調査と本記録。実装修正・稼働反映は未実施。
修正後のサービス操作が承認された場合は、Cc/Lictor の必要な配布更新を行い、
Excubitor 経由・プロジェクト本体フォルダから claim/release 付きで確認する。
終了済み4件を修復済み・再開済みとは扱わない。
