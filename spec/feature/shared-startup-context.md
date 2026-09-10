---
title: 新規セッションへの最小共通コンテキスト
service: concordia
domain: session-coordination
status: implemented
---

# 新規セッションへの最小共通コンテキスト

2026-09-10 neco 指示。「今後の起動のみ」。UX-CC-W1/W4/W5、CC-INV-01/02/04。
プロジェクト cwd から起動した人間操作のセッションが共通手順を見失わないための入口。

- session-lifecycle の新規 session 行登録分岐だけで、既存の作業ポリシー通知へ追加する。
  既存セッションの再登録・復帰・heartbeat・task変更へ再注入しない。既存セッションへの配布処理は作らない。
- session-coordination の `shared-startup-context.ts` が探索と案内を所有する。
  configured workspace roots のうち cwd を含む最長 root を選ぶ。範囲外は設定 root が1つの場合のみ選択し、
  複数候補・未設定なら不足を明示する。プロジェクト cwd、権限、session binding を変更しない。
- 共通リストは task/branch登録、session-end、ログ保存の最小手順。
  プロジェクト別のAGENTS.md（なければCLAUDE.md）、rule/README.md、メモリ索引はCc registryで確定した本体rootだけから選ぶ。
  Revisor手順はCcが対象projectを `revisor` workflowと判定した場合にだけ追加する。
  Cc管理UIと同じ登録リポ一覧のworkflowを読み、実repo origin（worktreeでも共通）を照合する。
  originなしの場合のみrootPathの完全一致を使い、フォルダ名や全体のCc workflowフラグから推測しない。
  登録レコードのworkflow省略は管理UIと同じ既存契約でrevisorと扱う。
  `github` はGitHubへのcommit/push/PR手順を注入し、Rvスキルは探索も案内もしない。
  未登録・重複・照会失敗はunknownを明示し、提出/push前にCc設定確認を促す。登録は失敗させない。
  作業ポリシーと共通資料は同一の判定結果を使う。汎用Cc startup packetも一律pushを指示しない。
  Castra の `.claude/skills/<name>/SKILL.md` と旧 `<name>.md` 形式を扱い、必要なら user `.codex/skills` を参照する。
  session-end は Castra `.claude/commands/session-end.md` を優先する。
- メモリは選定プロジェクトに対応する Claude project key の MEMORY.md だけを案内する。
  live index、Castra内 memory-backup、Archived/memory の順に実在・読取可能なものを選び、いずれも履歴資料として扱う。
  メモリ本文を起動プロンプトへ展開せず、索引から現在の作業に必要な項目だけ読む。全量復元・コピー・他project検索はしない。
- Ccが確認した絶対パスはJSON文字列として案内する。AI側のsandbox読取成功までは保証しない。
  不足・拒否時は未読を明示し、必要時に場所を確認する。登録自体を失敗させない。
- 終了手順の学習は終了の実行指示ではない。shutdownはユーザ明示指示時のみ。
  古いmemoryからpush・merge・test等の権限を取得しない。作業ポリシーもRevisorのno-pushと矛盾させない。

## ルール・スキル・自動確認

初回Injectのお願いは `rule/session-work.md` と `rule/shared-context.md` に分離し、起動文は
資料パスとCcが解決したworkflow/branchを中心にする。スキル候補の基準は `rule/skill-selection.md`。
Geniusの判断が頻回かつ安定、または頻回作業の損失が大きい手順だけをスキル化する。
`skills/session-followup/SKILL.md` は反復する確認手順を所有し、自動実行の許可は与えない。

既存10分走査はidle/cooldown/未回答/人間応答ゲートを維持し、候補のsession task、親としての委託、
workflow別PR状態からstateを判定する。PRはsessionと現在branchで絞る。
review-failed/merge-confirmation/review-wait/delegation-wait/task-active/completed/review-needed/unknownで
確認内容を切り替える。照会失敗はunknown。稼働中の委託を重複実行せず、レビュー中に再実装を促さない。
この状態判定はコマンド実行の権限ではない。push等の強制フックは別の実行境界で扱う。

## 新規起動セッションのGitフック

- `spawnSession` が一時領域の再利用可能なhook wrapperを準備する。repo/globalのGit configは編集しない。
  子プロセスの環境にcore.hooksPathを追加し、既存config countを保持する。準備失敗時は起動を失敗として返す。
- `pre-push` は自分のLictor sidecarからsession同一性を取得し、Ccの `POST /v1/sessions/:id/push-check`
  へ実checkout rootを渡す。Ccはworkspace内の実git状態、sessionのrepo/origin/branch、現在のworkflowを照合する。
  GitHub workflowだけ許可し、Rv/unknown/未登録/不一致/照会失敗/Castra rootを拒否する。
  登録・workflow・refの変更やpushそのものをAPI側で実行しない。決定はsession eventへ記録する。
- Ccのアドレスは既存のcatalog由来spawn environment、LictorはLICTOR_PORTから取得し固定ポートを持たない。
  サービスの起動や再起動をhookから行わない。headless等でsidecar同一性が取れないpushは拒否する。
- 元のglobal/local hook設定を復元した子プロセスで既存hookを呼び、stdin/argv/終了コードを引き継ぐ。
  main pushやLFSなどの既存hookを削除しない。Revisor本体の公開プロセスにはこのsession環境を設定しない。
- この変更はGit hookが呼ばれる操作を対象とする。`--no-verify`、環境削除、別Gitライブラリ等の
  意図的迂回に対するOS sandboxではない。provider固有の全ツール実行を捕捉したとは主張しない。
  command routing/作業イベントの既存hookは維持し、任意shellをAIの文章判定で代替する仕組みを追加しない。

## 検証・復旧

確認対象: 子repo/worktree・複数root・旧形式skill・欠落ファイル・共有索引のみ・既存sessionへの非再送。
ローカルでは型検査のみ。テスト・起動・再起動はユーザの明示指示なしに実行しない。
復旧はこの案内追加をrevertし再ビルド。既存資料やメモリ、稼働中セッションのデータ移行は不要。
