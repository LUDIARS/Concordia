---
id: CC-TASK-BRANCH-HARNESS
title: 作業境界とブランチの二重確認
status: draft
service: concordia
domain: harness-reliability
---

# 作業境界とブランチの二重確認

価値: UX-CC-W1 / UX-CC-W3、シナリオ UX-CC-S1 / S4。別作業の変更が提出済みの成果へ混ざらず、依頼者が何をレビューしているか分かる状態を守る。

2026-09-18 neco の開始指示: 通常フローを先行し、その後 Cf に拡張する。

## 所有と不変条件

- TB-MAIN: 通常フローで新規作業ブランチを作る起点はローカル main。HEAD・origin/main へ暗黙に置き換えない。既存ブランチの再開と新規作成を区別する。
- TB-START: 新規作業開始時に main 以外なら警告。編集は main から分離した作業ブランチで行う。
- TB-PR: PR 提出済みブランチでの別作業は classifier と決定的 gate の二重チェック。classifier 未確認を同一作業とみなさない。
- TB-PRESERVE: 切替時に既存変更を移送・破棄しない。別作業は main 起点の別 worktree に分離する。
- TB-AUTHORITY: Cc の設定・分類結果はテスト、デプロイ、マージ等の実行許可を追加しない。
- TB-MERGED: 提出境界の PR が正本 (Revisor の local PR / GitHub を反映した pr_records) でマージ済みと確認できたら、その境界を外す。照会は境界で拒否する直前だけ行い、読めない・遅い (3 秒)・未マージ (closed を含む) なら外さない (fail-closed)。照会中に別の PR が提出されたら新しい境界を残す。
- TB-RECOVER: 境界の拒否文には、requiresTaskBranchCheck の例外コマンドだけで組んだ復旧手順 (`lictor cli task set` / `git worktree add -b <b> <path> main`) を載せる。案内したコマンドが例外であることをテストで固定する。
- TB-REGISTERED: 実checkoutの照合は Cc の登録 (repo_path / branch) を基準にし、シェルの cwd を基準にしない。登録リポジトリ内 (本体・linked worktree を git common dir で同一視) なら登録 branch と一致すれば通す。登録外の cwd からのコマンドは、登録リポジトリに登録 branch の checkout が実在すれば通す。登録外 checkout の編集、登録 branch の checkout が無い登録は拒否する。

セッションのブランチ・作業・PR 提出境界は session-lifecycle の保存 API を介して記録する。純粋な分岐判断は harness-reliability、Git 読み取りは adapter、手順は use case が所有する。PR の状態は Rv / GitHub が正本であり、境界記録を審査通過と扱わない。

## 二重確認

classifier は提出時の作業と新規プロンプトを比較し、same-task / new-task / unknown を返す。PR 提出後の決定的 gate は、実ブランチ、提出時ブランチ、現在の登録タスク、分類済み対象を照合する。別作業なら編集を止め、main 起点の新しい作業ブランチへ案内する。同じ PR の修正は同じ作業として続ける。

## Cf 拡張

通常フローの確認に project / 潮流 / 亜流の一致条件を追加する。Cf の流れ選択を Rv / GitHub の選択と混同しない。違う潮流へ変更を持ち越さず、対象の作業環境へ移る。Cf の設定・実行経路が未接続の段階では有効化済みと報告しない。

## 調査根拠と検証

本体 main a77b9cd1。Anatomia context は concordia 登録を照会。Pf は Concordia 登録を確認。正本 UX-CC-PRODUCT とコードを照合した。
src/control/spawn-target.ts の新規 worktree 作成に HEAD 指定がある。既存 per-action branchBeforeEdit と per-prompt intent は存在するが、提出後の作業境界が未接続。
テストは回帰ケースを同じ変更に用意し、明示許可がないため実行しない。

## Cf の作業契約（2026-09-18）

目的は試遊結果と改修先の流れが混ざらない状態を守ること。Cc project_codes の conflux_flow は独立した master 設定、セッションの conflux_selection は user 状態であり、所有者は Cc。SQLite に保存し、認証情報・投稿本文は含めない。Rv/GitHub の選択は変更しない。

- CF-SELECT: 有効プロジェクトでは projectCode / tide / variant / baseBranch / workBranch を編集前に明示する。baseBranch は evolution/tide/variant またはその /main。本流の物理命名を固定せず、指定した実在ローカル参照を照合する。
- CF-ISOLATE: 作業ブランチは feature/tide/variant/task。選択と異なるブランチなら警告し、変更のない専用 worktree だけで対象へ切り替える。共有本体・他セッション・未コミット変更・別worktree使用中なら切替せず停止する。force、stash、変更の移送は行わない。
- CF-RETRY: 自動切替した操作は拒否し、新しいブランチ状態を再確認してから再試行する。起点の存在と既存作業ブランチの祖先関係を確認する。
- CF-COEXIST: Cf起点は選択した本流、通常起点はmain。PR後の別作業チェックはどちらにも適用する。

受入条件: 設定の独立保存、未選択の編集拒否、流れ間の切替、変更保持、main本体保護、他セッション保護、起点不一致拒否、切替後の登録更新、PR境界維持をテストに記述する。KD/Mp の設定反映はAPI配備後に行い、未配備を有効と報告しない。

## 実装結果と復旧

2026-09-18: サーバーとWebのTypeScript静的検査、追加3テストファイルとspawn-targetテストの型検査、hookの構文検査、git diff --checkを実施。Anatomia verifyはrule_conformance / duplication / spec_linkage / coupling_delta / convention_driftの5項目PASS。単体・統合・起動テスト、再起動、デプロイ、マージは未実施。

配備後の復旧はCf設定をOFFにして通常フローへ戻す。保存済みの流れ選択・PR境界を消さず、実ブランチとCc登録を照合する。切替が完了して登録だけ失敗した場合も自動編集を許可せず、Git実状態を確認して再登録する。migrationの列を削除しない。Cf本体の成果物生成・配布・合流UIは別実装であり、この変更だけでは提供済みにならない。

## 登録基準の照合（2026-09-19）

neco 指示「Ccの登録がなされていれば権限を与える」。症状: Cc 登録 (Conflux / main) が実在するのに、シェルの cwd が Castra root に残っただけで全コマンドが task-branch で拒否された。linked worktree も Lictor が本体 checkout のパスで登録するため一致しなかった。TB-REGISTERED を追加し、判定は checkRegisteredCheckout (純関数)、Git 読み取りは readBranchSnapshot に common dir と worktree 一覧を追加した。PR 境界照合は登録パスで行う。
検証: サーバー TypeScript 静的検査、task-branch / task-branch-adapters / conflux の 3 テストファイル 27 件成功 (実 Git の linked worktree を含む)。Anatomia verify は coupling_delta が readBranchSnapshot の既存超過 (fanOut 77→78) で warn、他 4 項目 PASS。再起動・デプロイは未実施。
復旧: 本変更を revert すれば cwd 基準の照合へ戻る。データ・migration の変更はない。

## マージ済み境界の解除と復旧案内（2026-09-19）

neco 指示「自力でブランチを戻せる権限を用意」→ 回答「拒否文に復旧手順を載せる / マージ時に自動で解除」。
症状: Excubitor の local PR を提出する前にセッション登録を PR ブランチへ PATCH したまま、PR が自動マージされた。
その後の後片付けで Bash / Edit / Write がすべて submitted-task-boundary で拒否された。分類器は不在 (「判断代行が不在」) で
解除されず、Lictor は自分の見るブランチが変わらないため登録を上書きしなかった。例外コマンド `lictor cli task set` で
抜け出せたが、拒否文がそれを案内していなかった。

- TB-RECOVER: 案内文は純関数側の定数 `SUBMITTED_BOUNDARY_RECOVERY` に置き、checkSubmittedTask の suggestion に付ける。
- TB-MERGED: 判断は純関数 `releasesSubmittedBoundary`、正本の照会は adapter `submittedPrStateReader`
  (`src/harness/reliability/task-branch-merge-state.ts`)、手順は `TaskBranchService.gate` が持つ。境界に記録される
  PR 参照は 3 形 (Revisor local PR の id / GitHub PR の URL / `<owner>/<repo>#<number>`) で、local PR は Revisor の一覧、
  GitHub は pr_records の state で判定する。Revisor の完了通知はセッションへの文面 inject で構造化されていないため、
  通知を購読せず、拒否直前の照会で解除する (照会はまれな拒否時だけで、通常のツール呼び出しには負荷をかけない)。
- 境界の記録は session metadata の `task_branch_submission` で、解除はそのキーの削除。他の metadata は保つ。

検証: サーバー TypeScript 静的検査。回帰テストは task-branch.test.ts (TB-RECOVER 1 件 / TB-MERGED 3 件) と
task-branch-merge-state.test.ts (3 件) を追加し、明示許可がないため未実行。再起動・デプロイは未実施。
復旧: revert すれば、マージ後も境界が残り分類器か `lictor cli task set` でしか抜けられない従来動作に戻る。データ・migration の変更はない。

## Augur台帳での検証対象

追加したtask-branch、task-branch-adapters、confluxの3テストファイルを .augur/tests.jsonl に登録する。テスト作成者はsession、実行回数0を保持し、未実行を成功としない。cc.acceptance.jsonは実装対応、Augur台帳は審査で選択するテストの正本。台帳ファイルの所属はtooling、各テストの業務所属はharness-reliability等の既存境界。
審査用worktreeでVitest不在を確認した。RevisorのAugur経路がbootstrapを省略する問題は別サービス側の修正が必要であり、台帳を削除して全体スイートへ迂回しない。

## レビュー失敗の修正（2026-09-18）

UX-CC-W1/W3 と TB-MAIN の回帰条件として、管理APIのGit fixtureは初期ブランチをmainに固定する。環境のinit.defaultBranchに依存させない。fixtureはテストが所有し、実際の新規worktreeの起点は引き続きmainとする。
Cfの実Gitテストは4回の状態照合とブランチ切替を含むため、このケースだけ60秒の上限を明示する。個々のGit操作の5秒上限および保護条件の検証は変更しない。保存済み審査結果では約5秒のVitestタイムアウトを確認した。修正後のテストは実行許可待ちであり、成功とは記録しない。

08:16の外部審査も修正前HEAD ebbac2f0が対象。toolingで失敗した登録は管理APIと同じt-a76cff7e06e6であり、今回の保存結果にはJSON解析失敗は出ていない。変更した2テストのTypeScript型検査は診断0。ローカルテストは未実行。
