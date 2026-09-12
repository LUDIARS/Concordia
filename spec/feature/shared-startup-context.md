---
title: 新規セッションへの最小共通コンテキスト
service: concordia
domain: session-coordination
status: implemented
---

# 新規セッションへの最小共通コンテキスト

2026-09-12 追加: [作業段階](session-work-phases.md)を初期 inject と定期確認で参照する。
設計が固まったら人間に実装開始を確認し、同じ範囲の開始指示を確認済みなら作業を進める。
Cc は設計・確認・実装・調整を稼働状態とは別に保存する。新規起動は設計、既存未記録は未確認。
定期確認は記録と会話を照合して設計の状態を再評価させ、回答待ちを解除しない。
`design-assessment` / `start-confirmation` / `implementation` / `adjustment` を追加し、
既存の PR・委託の状態も維持する。外部 workflow 取得失敗でも Cc の記録から設計評価を案内できる。

2026-09-10 neco 指示。「今後の起動のみ」。UX-CC-W1/W4/W5、CC-INV-01/02/04。
プロジェクト cwd から起動した人間操作のセッションが共通手順を見失わないための入口。

- 初期Injectを主経路とし、SessionStartと入力時のフックは同じCc判定を照合する。
  同じ設定版では再注入せず、branch・project・workflow・必須設定の変更時だけ訂正する。
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
  正常取得した一覧で未登録と確認でき、remoteがGitHub repositoryを識別できる場合は通常のgithub workflowとする。
  未登録と照会失敗を混同しない。remote不明・重複・不正応答・照会失敗はunknownとし、push許可へ倒さない。
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

### 初期ポリシーの版と照合

UX-CC-W1/W4/W5、CC-INV-01/02/04。`startup-policy.ts` が初期案内と照合の共通組立てを所有する。
workflow、登録repo/branch/provider、本体root、DDD・通常テスト・オンタイム・作業契約の設定と案内版からrevisionを作る。
設定不明はfalseと区別し、必須設定は実行許可を追加しない。`startup-policy-check.ts` はSessionStart・入力境界で再照合する。
初回は全案内、変更時は変わった項目だけをInjectする。資料の選択が変わる場合は該当する資料案内も渡す。
フックが報告したcwd/branch/providerは登録の上書きに使わず、不一致を返す。Castra起点の明示的な子repo登録も保つ。
同時照合と古い非同期応答で新しい版を上書きしない。保存する配送状態はqueuedであり、AIの読了・受領済みとは扱わない。
SessionStartで版記録が欠けていれば初期案内を補完する。配送確認がない場合はunconfirmedと表示し、盲目的に同じInjectを繰り返さない。
設定変更の通知は次の登録更新・SessionStart・入力境界で行い、常駐監視を増やさない。

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
  GitHub workflowだけ許可し、Rv/unknown/不一致/照会失敗/Castra rootを拒否する。
  Rv未登録と確認済みのGitHub repoは、GitHub Appの導入やRv登録をpushの前提にしない。
  登録・workflow・refの変更やpushそのものをAPI側で実行しない。決定はsession eventへ記録する。
- Ccのアドレスは既存のcatalog由来spawn environment、LictorはLICTOR_PORTから取得し固定ポートを持たない。
  サービスの起動や再起動をhookから行わない。headless等でsidecar同一性が取れないpushは拒否する。
- 元のglobal/local hook設定を復元した子プロセスで既存hookを呼び、stdin/argv/終了コードを引き継ぐ。
  Ccの挿入スロット以後に追加されたGit設定も保持する。後続の別hooksPath、欠損・不正な設定配列は拒否し、Ccのスロットだけを除去して後続を詰め直す。
  main pushやLFSなどの既存hookを削除しない。Revisor本体の公開プロセスにはこのsession環境を設定しない。
- この変更はGit hookが呼ばれる操作を対象とする。`--no-verify`、環境削除、別Gitライブラリ等の
  意図的迂回に対するOS sandboxではない。provider固有の全ツール実行を捕捉したとは主張しない。
  command routing/作業イベントの既存hookは維持し、任意shellをAIの文章判定で代替する仕組みを追加しない。

## 検証・復旧

登録テストの一時Git fixtureはセッション対象repoではない。fixtureの準備はローカルbare repoからfetchし、セッションのpush許可やGitフックを無効化しない。develop clone検証では公開adapterだけをローカルfixture操作へ差し替え、CLIは既存のpush実装を用いる。

確認対象: 子repo/worktree・複数root・旧形式skill・欠落ファイル・共有索引のみ・既存sessionへの非再送。
ローカルでは型検査のみ。テスト・起動・再起動はユーザの明示指示なしに実行しない。
復旧はこの案内追加をrevertし再ビルド。既存資料やメモリ、稼働中セッションのデータ移行は不要。
