---
title: Discord雑務とWeb専用ページ
id: CC-CHORES
status: draft
---

# 雑務のワンショットと継続

2026-09-25 neco指示: Discordに雑務チャンネル、WebUIに専用ページを作る。
専用ディレクトリで `claude -p` または `codex exec` を実行し、完了後にOK/Continueを提示する。
Continueのみ通常のCcセッションをspawnする。

## 価値・所属

UX-CC-W2/W4/W5、UX-CC-S2/S3/S5。失うと困る状態は元の依頼、作業成果、
人間の完了/継続選択、継続起動の同一性。実行終了と成果の承認を区別する。
`chores` は agent-delegation 内の小さな状態所有境界。Discord、HTTP、CLI、保存はadapter。
既存spawnerと認可を利用し、delegation run/sessionの状態を直接書き換えない。
不変条件: CC-INV-02/03/04/06/07/08。

## 契約 CC-CHORES-01

- 本社Discordの「雑務」で人間の投稿を受付。既存のsession起動権限を毎回確認する。
  bot/webhook/別guild/子会社の投稿は処理しない。既定Claude、先頭 `[codex]` でCodexを選べる。
- `/chores` に投稿フォーム、実行一覧、結果、OK/Continue、継続起動IDを表示する。
  HTTPは既存Ccの信頼済み管理面の境界を継承する。
- 実行前に依頼IDと入力をSQLiteへ保存。同じ受付キーは同じrunを返し、異なる本文の再利用は拒否。
  作業場所はworkspace配下 `.concordia-chores/<run UUID>`。任意cwd/CLI引数を入力から受けない。
- 同時実行は1件、待ち行列は最大20件、本文は16000文字、出力は128KiB、期限は10分。
  providerはclaude/codexのみ。コスト上限時は新規実行/継続を拒否する。
- 状態はqueued→running→succeeded/failed。結果不明はinterrupted、継続結果不明はcontinuing。
  中断した実行/継続を自動再実行しない。期限後のrunningはinterruptedとして照合待ちを表示する。
- succeeded/failed→OK(acknowledged)、またはContinue(continuing→continued)。CASで一方だけ受理。
  Continueは元の依頼・結果・同じcwdを引き継ぎ、固定spawn IDで相関する。
  起動失敗が確定した場合だけ元状態へ戻す。結果不明は継続待ちに残す。
- 実行結果を保存してからDiscord配達。配達失敗は実行を取り消さず再送可能。
  保存したメッセージIDとnonceで重複を抑える。保証は厳密なexactly-onceではない。
  Discordが停止してもWebから結果を読める。結果本文はツール出力として扱い、メンションを抑止する。
- ワンショットのClaudeは `--model claude-opus-5-5 --effort medium`、Codexは
  `--model gpt-5.6-terra -c model_reasoning_effort="xhigh"` を明示する。
  CLI既定モデルや既定effortに依存しない。2026-09-25 necoのmid指定はmediumに対応する。
- CLI子プロセスは専用cwd・shellなし・UTF-8 stdin/stdoutで実行。親のCc/Lictor識別環境を引き継がない。
  既存CLI権限を使用し、permission bypassフラグを追加しない。
  通常停止は受付停止、実行abort、close待ち、結果保存を経てDBを閉じる。

## 実装と受入

`src/chores/domain.ts`: 遷移と入力規則。
`src/chores/repository.ts`: 永続化、受付同一性、CAS。
`src/chores/service.ts`: 受付、実行、選択のuse case。
`src/chores/cli.ts`: 子プロセス寿命と出力境界。
`src/chores/runtime.ts`: 専用cwd、引継ぎファイル、既存spawnとの組立て。
`src/api/chores.ts`: HTTP入力検証と操作面。
`src/discord/chores.ts`: チャンネル準備、認可、結果カードとボタン、配達の再試行。
`src/bootstrap/core.ts` / `src/api/register-core.ts` / `src/discord/bot.ts`: 寿命と経路の配線。
`web/src/pages/Chores.tsx` / `web/src/App.tsx`: 専用ページと導線。

テストは同じ境界の失敗・二重要求・継続競合・認可・表示を対象とし、cc.acceptance.jsonに登録する。
テスト実行、配備、実機観察は未実施を成功に読み替えない。
調査基点: main 688aef47。PfのConcordia登録は存在するがuxGoalは空。
Anatomia HTTPは接続拒否、CLI contextも期限内に返らず、repoのspec/ux・domain宣言とソースを照合した。
worktreeを対象にしたCLI pr-reviewは完走。所属なし・仕様参照なし・変更箇所の規約違反はいずれも0。
新規src/choresの技術層を `.anatomia/layers.json` に明記する。
backend・WebUI・追加テストの型チェックは成功。全体テスト型チェックは既存4ファイルの型エラーで失敗。
単体/統合テストは本セッションでは未実行。Revisorで登録した受入テストを実行する。

## Revisor #1978 の登録修正

2026-09-25: cc.acceptance.jsonの対応付けに加え、既存のAugur登録処理で
新規8テストを `.augur/tests.jsonl` に登録した。宣言済みmembershipから所属を求め、
WebのChoresテストはchores/http-interface/web-test-toolingに関連付ける。
前回審査のservice-deployed-notifyはexit 2、runIdなしで未実行扱い。詳細出力が
審査結果に保存されておらず、原因は未確定。既存10テストのファイル実在を確認した。
この変更では既存テストの無効化・省略・合格扱いへの変更は行わない。
登録8件のID重複なし・ファイル実在と `git diff --check` を確認。
`git diff | anatomia verify --repo ...` は長時間無応答のため中断し、今回の検査は未確認。
セッション自身のテストは未実行。再提出後のRevisor実行結果をもって検証する。

## 復旧

interrupted/continuingはCLIやspawn IDの実在を調べ、勝手に再送しない。
CLI完了が不明な場合はWebで依頼とcwdを示し、運用者が残存処理を確認する。
配達未完了は保存済み結果から再配達する。変更の取り下げ時も台帳と作業フォルダは保持する。
