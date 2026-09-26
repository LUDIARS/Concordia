---
name: script-creator
description: Cc所有の共通ツールで再利用可能なNodeスクリプトを登録・検証する。「ツール作成」「スクリプトにして」「コマンドにして」などの依頼に使う。単発の通常編集や、既存コマンドの実行だけには使わない。
---

# Script creator

対象repositoryと目的・引数・副作用を確認し、既存のcommand-runner操作や登録済みスクリプトを先に探す。新しいスクリプトごとに特権コマンドや許可ルールを追加しない。定義とテストは対象repo、作成・検証・実行の共通処理はCcが所有する。

共通入口は `node E:/Document/Ars/command-runner.mjs script:<operation>`。操作は `create / list / inspect / verify / run`。配備前の開発検証のみ、Cc worktreeの `tools/command-tools/cli.mjs` を同じ引数で呼べる。入口が未配備なら明示し、別の権限経路へ切り替えない。

1. `script:list --repo <対象repo>` で重複を調べる。
2. UTF-8 JSONファイルを作る。必須項目は `id`（小文字英字から始まる英数字とハイフン）、`description`、`arguments`（`{name, required}` の配列）、`requiredPermissions`、`script`、`test`。
   - 権限ラベルは `workspace-read / workspace-write / network / service-control / external-publish`。必要な作用を漏らさず宣言する。ラベルは実行権限やsandboxではない。
   - `script` はNode ES module。引数は `JSON.parse(process.argv[2])` のオブジェクトで受ける。シェル文字列を組み立てない。
   - `test` はNode組込みの `node:test` と `node:assert` を使い、正常系だけでなく副作用境界・失敗を検証する。実サービスへ接続しないfixtureを優先する。
   - 秘密、固定session ID、実行するためだけの権限緩和を埋め込まない。
3. `script:create --repo <repo> --request <JSONファイル>`。作成は実行しない。同じID・内容なら変更なし、違う内容なら競合になる。既存定義を勝手に上書きしない。
4. `script:inspect --repo <repo> --id <id>` で作用・引数・digestを確認する。生成された `tools/generated-scripts/<id>/` のコードとテストをレビューする。
5. テスト実行が依頼の許可範囲に入る場合だけ `script:verify --repo <repo> --id <id> --digest <digest>`。Ccのtesting claim/releaseなど対象の規則を守る。テストもコード実行であり、作成依頼だけからサービス操作や公開を許可されたと解釈しない。
6. 実際の操作が許可されている場合だけ `script:run --repo <repo> --id <id> --digest <digest> --arguments <値のJSONファイル> --run-id <依頼ID>`。通常のハーネス承認を通し、command-runner全体の無条件許可を追加しない。

検証成功は対象digestだけに有効。編集後はinspectとverifyをやり直す。run IDの再利用は既存結果の照合であり、実行し直す命令ではない。`unknown`、`started`、残ったlockは外部状態と元のプロセスを確認し、結果不明のまま新しいIDで再実行しない。時間経過だけでlockを削除しない。

完了報告では作成・検証・実行・配備を分け、未実施を明記する。既存のサービス起動や公開フローを生成スクリプトで迂回しない。契約と復旧条件はCcの `spec/feature/script-creator.md` を参照する。
