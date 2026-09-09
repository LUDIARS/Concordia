# 子会社 Astra の対話セッションが初回回答で終了する

- Date: 2026-09-09
- Status: deployed — Cc通常spawnの対話transportを明示、稼働成果物へ反映済み。未マージ・動作テスト未実施。
- Area: Cc forum spawn / Lictor Codex transport / session lifecycle
- Severity: 高。追加質問・確認回答・実装継続の窓口が閉じる。
- Scope: 追加指示「修正して反映」に従い実装へ拡張。TypeScriptビルド成功。テスト・マージは未実施。
- UX: UX-CC-W2（同一依頼を継続・再開できる）、UX-CC-W3（終了と成果を区別する）。

## Summary

neco から「子会社の Astra セッションがすぐ終わる」と報告された。
Cc はフォーラムを対話窓口として起動するが、初期依頼文を一回実行の委託用環境変数
`CONCORDIA_DELEGATION_PROMPT_FILE` で渡している。Lictor はその有無を実行モードの
判定に使うため、最初の Codex ターンが正常完了するとセッション全体を終了する。
2026-09-02 の「フォーラムを一問一答の委託にしない」という意図が下流まで成立していない修正漏れ。
ユーザー視点では早期終了問題の再発だが、直近の変更で正常な Astra 経路を壊したとは断定しない。
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

### 他セッションでは起きない理由と、いつ入り込んだか

neco の追加質問: 「他のセッションだと起きてなくない？ 以前は問題なかった。何でデグレった？」

結論: 全セッション共通でも Astra 固有でもない。初期 prompt 付き Codex の経路だけが
一回実行として扱われる。最近の Astra 終了処理変更ではなく、古い判定と9月2日の
フォーラム改修の契約不一致が残存し、Astra 利用で表面化したと判断する。

| 経路 | 実装の判定 | 観測例 |
|---|---|---|
| 本社の初期作業依頼なし Astra 起動 | legacy 対話 | 09-08 17:14開始の Corpus 作業は54,877秒継続、rollout transcriptあり |
| 子会社の本文付き Claude | Codex専用分岐を通らずPTY対話 | 09-08 21:00開始の Opus は36,825秒、09-08 20:02開始の Sonnet は8,810秒継続 |
| 子会社の本文付き Astra | App Server 一回実行 | 本報告の4件、初回ターン正常完了直後に終了 |
| 子会社の本文付き Sol | 同じ App Server 一回実行 | 09-09 14:01:15開始、14:07:30に初回正常完了と同時に終了（375秒） |

Sol の session は `lictor-433c8db7-18f5-42a3-a461-e8b1d0809744`。
最終回答は追加ログの提示を求めており、対話を続ける必要がある状態で窓口が閉じた。
本社例の metadata の初期文は共通の待機指示（「追加のタスク指示があるまで待機せよ」）で、
フォーラム初期依頼はなく、rollout transcript を持つ。チャットへ後から注入する待機指示と、
起動環境変数で渡す依頼本文は区別する。
本社／子会社という組織区分そのものではなく、provider と初期 prompt が実装上の判定軸。

変更履歴（commit日時 JST、配布日時そのものではない）:

1. Lictor `abd3cc99` / PR #82（2026-07-11 22:30）:
   App Server の委託実行を追加。ターン1回の後に close/unregister/return する処理が入った。
2. Lictor `5431f331` / PR #85（2026-07-13 07:35）:
   対話起動の即死を修正するため、promptなしを legacy に戻した。
   ただし「promptあり＝委託」という判定は維持した。この判定と一回終了処理は以後も残っている。
3. Cc `1ad70afa2`（2026-07-17）:
   provider直指定の adHocPrompt を `CONCORDIA_DELEGATION_PROMPT_FILE` で渡す行の由来。
4. Cc `ed067866`（2026-09-02 09:03）:
   早期終了対策として forum を delegation/invoke から admin/spawn-session へ変更。
   同時に template 起動の `inject_prompt:false` でも forum本文を startupText に合成し、
   委託用環境変数で送るようにした。API名は通常spawnになったが、Lictor の実行モードは
   一回実行のまま。Claude では成立しても Codex に修正が届かなかった。
5. Cc `67a951af`（2026-09-02 18:53）:
   forum のモデル直指定経路を追加。直指定も同じ環境変数を使用する既存経路につながった。
6. Cc `7b40936c`（2026-09-06 20:26）:
   Astra をモデルカタログ・委託テンプレートに追加。取得できた子会社 Astra の最初の開始は
   09-07 21:54、初回正常完了直後の終了を確認できる最初の例は09-08 06:42。

したがって、9月2日の修正が Codex まで成立していなかったことは履歴から説明できる。
「同じ子会社・本文付き・同じ Codex provider の Astra が以前は複数ターン継続した」証拠は
今回の保有記録にはなく、それが後日の特定commitで壊れたという経緯は確認できない。
初期報告の単純な「回帰」という表現を、修正漏れと利用経路の変化に分けて補足する。

### 見逃された確認境界

`src/discord/forum-spawn.test.ts` の通常spawnテストはHTTP先・payload・prompt内容までを
mockで確認する。Lictor `tests/codex-transport.test.ts` はpromptありをapp-serverとする
既存判定を正解として確認する。両者をつなぐ「初期prompt付き通常spawnが初回回答後も
継続する」という確認がなく、個別の期待値が通っても利用者の対話契約を保証できない。
これはテストコードの静的確認であり、今回テストを実行した結果ではない。

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

追加指示により、Cc の通常spawn2経路に `interactiveSpawnEnvironment` を適用した。
Codex の通常起動では `LICTOR_CODEX_TRANSPORT=legacy` を明示し、初期promptファイルを
既存のPTY配送経路に渡す。真のdelegation invoke/launcherの処理は変更していない。
詳細契約は `spec/feature/interactive-codex-startup.md`。
`tsc -p tsconfig.json --noEmitOnError` は終了コード0。テストは実施していない。
Genius判断カードは照会APIが到達不能だったため、Cc/Lictorの現行コードと履歴で判断した。
2026-09-09 14:24 JST、修正commit `98c0d838` のコンパイル成果物を本体distへ反映した。
対象は `api/register-core.js`、`control/interactive-spawn-env.js` と各source mapの計4ファイル。
既存register-core.jsとの差分が今回の変更だけであること、コピー後のSHA-256一致を確認した。
退避先: `E:/Document/Ars/.deployment-backups/Cc-astra-interactive-20260909-98c0d838`。
manifestにファイル一覧・旧ファイル有無・新hashを保存した。

Concordia testing claim成功（競合0）→ Excubitor restart成功 → Excubitor running確認
（PID `27780 → 37272`）→ testing release成功（1件）。全サービス操作はCc本体cwdで行った。
テストセッションは起動しておらず、実際の複数ターン対話は未検証。
効果は新規通常Codex起動から。既存・終了済みSessionを変更／復活させていない。

ユーザーのマージ・main更新禁止を維持し、本体branch/headは `main / abb7423e` のまま。
反映は稼働distのみであり、未マージの本体ソースから再ビルドすると修正は失われる。
今後の再ビルド前にPRの扱いを確定するか、同じ修正成果物を維持する必要がある。
修正後のサービス操作が承認された場合は、Cc/Lictor の必要な配布更新を行い、
Excubitor 経由・プロジェクト本体フォルダから claim/release 付きで確認する。
終了済み4件を修復済み・再開済みとは扱わない。
