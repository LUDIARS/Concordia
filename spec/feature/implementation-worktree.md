---
title: Ccが作成する作業worktreeとActio参照
type: feature
service: concordia
domain: project-code-registry
status: draft
---

# Ccが作成する作業worktreeとActio参照

2026-09-25 necoの「Actioに登録されているならそれでいい」「wtをCcがツールで作成」「ignore領域に情報を置く」「ツール作って対応」に対応する。

## 価値・所属・状態所有者

UX-CC-W1/W2/W5、S1/S3: 利用者が同じプロジェクトを二重登録せず、正しい作業先からタスクを扱え、応答喪失後も同じ作業先へ戻れる状態を守る。

- project-code-registry: 既存のGitリポジトリとプロジェクトコードの対応を所有する。
- Actio: プロジェクトの有効な登録、タスク本文・業務状態と所有者を所有する。
- taskflow: 登録を照合して使用する。追加のプロジェクト台帳を永続化しない。
- implementation-tools: worktree作成とignoredメタデータの配置、既存session bindingへの接続を行う。
- Git: main・branch・linked worktreeの関係を所有する。ローカルメタデータは照合材料であり、認証・認可の正本ではない。

CC-INV-01/02/03/04を適用する。既存taskflow/agent-delegation/project-code-registry/http-interface/runtime-orchestrationへ所属し、新しい業務ドメインを増やさない。

## CC-AT-DISCOVERY-01: 二重登録の廃止

本社のローカル個人運用では、既存project-code registryでGit本体リポジトリを特定し、Actioの`/api/projects/cc`に同じコードが1件あることを確認する。名称やworktree名の曖昧一致では選ばない。

`/api/auth/me`が`actio-local`・`localMode: true`・`access: loopback`を返すことを毎回確認し、タスクのowner/team/source検査を維持する。未登録、重複、認証不一致、サービス停止を空の成功にしない。Actio登録の追加は次の照会で反映し、Ccの個別設定追加や再起動を要求しない。

既存の明示bindingは互換のため優先する。bearerのみを明示した構成や子会社の要求をローカル認証へ切り替えない。明示設定の不正・重複を自動解決で隠さない。設定そのものが無いローカル環境ではActioの実認証を照合して解決する。

## CC-WORKTREE-01: 作成ツール

MCP `concordia_create_worktree` と `POST /v1/implementation-tools/worktree` を提供する。入力は自分のsession、登録済みproject code、作成branch、作業の説明。MCPはLictor sidecarから自分のsessionを取得し、他sessionを指定する引数を持たない。

処理は、active session・workspace・登録repo・組織・Actio参照の確認→branch/worktreeの所有確認→既存Git adapterによるローカルmain起点の作成→ignoredメタデータ配置→既存bind、の順とする。共有checkoutのswitch、remote起点の新branch作成、push、サービス起動、テストを実行しない。

同じsession/project/branchの再送は同じworktreeを再利用する。別sessionの所有、既存の未所有branch、workspace外、不正branch、別Gitリポジトリは拒否する。作成後の配置・bind失敗でworktreeや利用者のファイルを強制削除しない。所有記録と実Gitを照合し、同じ入力の再送で復旧する。

## CC-WORKTREE-META-01: ignored領域

worktree内の`.local/concordia/worktree.json`へスキーマ版、本体repo、worktree、branch、project code、Actio project参照、所有識別を記録する。タスク本文、認証トークン、証拠本文は保存しない。`.git/info/exclude`へ対象領域を追加し、追跡されていないこと・除外されることを確認する。リポジトリの`.gitignore`へ機械固有情報を足さない。

symlink/junction経由の領域外書込み、追跡済みファイルの上書き、別所有者の記録の上書きは拒否する。書込みは排他的に行い、再送時は既存記録を検査する。メタデータのActio参照だけでは操作せず、Actioの現在の登録と認証を確認する。

Git作成前に本体の同じignored領域へ `allocation-<branchのSHA256>.json` を予約する。所有識別はsession IDのSHA256で、生のIDを保存しない。作成直後の中断でも予約を照合して復旧できる。base commitは最初のlocal mainの値を保存し、mainが進んでも再送時に変更しない。予約は利用者の作業保存のため自動削除しない。

利用例: `concordia_create_worktree({project_code: "El", branch: "feat/game-quality", task: "評価辞書を増やす"})`。返された `cwd` を以後の編集先にする。HTTPクライアントは自分のsidecarが返すsession IDを `session_id` に設定する。ツールの配置後も既に存在する手作業worktreeは引き取らず、新しい作業から使用する。

## 受入と復旧

main/worktreeの同一解決、個別binding無し、登録の追加・削除・重複、明示binding互換、認証・組織の拒否、local main起点、再送、競合、ignored配置、追跡済み・リンク拒否、配置後bind失敗を回帰ケースにする。source/testsを`cc.acceptance.json`へ登録する。

本変更は運用設定の書換え、タスク移行、Cc再起動を含まない。未実行のテストと実稼働未反映を明記する。既存worktreeを削除せず、問題時はツールの使用を止めて保存記録とGitの状態を確認する。

調査根拠: Pf ConcordiaのActio正本化フラグメント`01M206XEV4JRC1N3PMEZGGN2P5`、Anatomia plan `94a96dc9a589f386`、本体のtaskflow v3/implementation-tools/spawn-target。Anatomiaの旧worktree由来の仕様は現行v3で置き換えて読む。

## 2026-09-25 静的検証記録

- 本体のTypeScript型検査は成功。追加した回帰コードに型エラー無し。
- 全テストコードの型検査は、変更していない `src/api/work-submission-routes.test.ts:43`、`src/discord/image-inbox.test.ts:96`、`tests/ontime-runtime.test.ts:5` の既存3エラーにより不成功。テスト本体は実行していない。
- 差分の空白検査、変更したTypeScriptファイルのspecRefs付きmembership、source/tests/contracts対応は確認済み。
- `git diff --cached | anatomia verify --repo <worktree>` を実施。rule_conformance / duplication / spec_linkage / convention_driftは成功。coupling_deltaは、excludeMetadata=21・keepWorktreeRecord=27・reserveWorktree=19がp95=16を超える警告を残し、全体判定はfalse。作成use caseと対象確認・所有予約・保存adapterは分割済み。指標を満たすためだけの追加分割は行わず、審査へ明示する。
- 実サービスのツール呼出し・起動・再起動・タスク移行・設定変更は未実施。

### PR1982のconfiguration指摘への修正

Revisor run `r-20260925041900284-049cff69` で、設定カバレッジが `EXCUBITOR_SERVICE_CONFIG_JSON` / `LICTOR_PORT` の未登録を検出した。設定レジストリへ前者をsecret、後者を既定値なしのintegerとして追加し、ともに環境注入専用・汎用PUT不可とした。秘匿・未設定・編集拒否の回帰を既存registryテストへ追加した。

修正後の本体型検査、対象のregistry/coverageテストコードの型検査、修正差分に対するAnatomiaの全5ゲートは成功。これは静的検査の結果であり、登録テストの成功はRevisor再審査で確認する。session自身でテストや再起動は実行していない。
