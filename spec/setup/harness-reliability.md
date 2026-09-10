# ハーネスの導入と確認

実装仕様は `spec/feature/harness-reliability.md`、受入設定は
`spec/feature/project-harness-policy.md`。本書の手順は導入状況の正本を置き換えない。

## 配置・プロジェクト設定

1. レビュー・反映後、Ccのschema migration 99で `tests_required`、`ontime_tests_required` を追加する。
   既存プロジェクトはfalseのまま。DDDは `ddd_enabled` を再利用する。
2. `/projects` で対象プロジェクトの必須設定を選択する。通常テストとオンタイムは実装要件で、
   テスト実行・再起動・デプロイの追加許可ではない。
3. `/v1/setup?provider=codex-cli&repo_path=<対象本体repo>` または `claude-code` を取得する。
   `install.skills` の全ファイルを配置し、`settings_merge` を既存hook設定へマージする。
   一時worktreeへの絶対パスを常設設定に残さない。
4. Codexは `.codex/hooks.json` と `/hooks` で信頼を確認する。クライアントの承認をスクリプトで回避しない。
5. セッションの関連作業欄でイベント・時刻・結果を確認する。設定済みだけで正常としない。

通常のコード編集時に必要条件を案内し、commit/push/提出コマンドのフックとCcのlocal PR提出経路で
証跡を確認する。構造的な検査に加え、テストの十分性やDDDの意味的品質はレビューする。
削除・文書のみの変更は新しいコード実装として数えない。

```json
{
  "version": 1,
  "implementations": [
    { "source": "src/example.ts", "tests": ["tests/example.test.ts"], "contracts": ["C-example"] }
  ]
}
```

この対応表を `cc.acceptance.json` に置く。オンタイム必須時は参照するAugur契約、述語module、
対象コードの計測挿入も必要。存在確認をテスト実行成功と扱わず、APIでは `execution: not_checked` を返す。

## LLMなしのオンタイム手順

Ccでは `augur.contracts.json` に初動/中間サンプリングの予算と自動通知の調査誘導除外を定義している。
純粋述語は `src/harness/reliability/contracts/`。通常呼び出しで検査し、観測をVg JSONLへ出力する。
共通log-weaverにcontract runtimeがまだないため、Ccの `ontime-runtime.ts` を互換adapterとして使う。
モデル・クラシファイア・AI APIへの接続を必要としない。

```text
node tools/concordia-ontime.mjs install --augur <Augur本体>/bin/augur.mjs
node tools/concordia-ontime.mjs lint --augur <Augur本体>/bin/augur.mjs
node tools/concordia-ontime.mjs report --augur <Augur本体>/bin/augur.mjs --since <観測開始ISO日時> --logs-dir <JSONLディレクトリ>
```

installはAugurの既存挿入スクリプトを使用し、生成されたpredicate importだけNode16向け`.js`へ正規化する。
業務固有の条件そのものは人間または通常の実装工程で定義する。実行時にLLMで条件を補完・推測しない。
`observe`、`sample: 1` を固定し、本来の戻り値・例外を変えない。秘密・引数・例外本文をログへ記録しない。
レポートの終了コードだけで合格とせず、各項目の `met` を確認する。未観測は `met: false`。
関連作業欄にはCcプロセス全体の条件充足・違反・述語例外を表示する。再起動で表示カウンターはリセットするため、
期間とmarkerを照合した永続的な受入証跡にはAugur reportを使う。

## 隔離テスト

ユーザーが許可した範囲で、cc-testのclaim/releaseを使う。

```text
node node_modules/vitest/vitest.mjs run --config vitest.harness.config.ts
node node_modules/vitest/vitest.mjs run src/control/compaction.test.ts src/delegation/completion-evidence.test.ts
```

ハーネスfixtureはSQLite・時刻・乱数・通知・分類器を隔離する。Augur往復テストは隣接Augur本体のCLIを
起動し、テンポラリJSONLだけを集計する（AugurサーバーやLLMは起動しない）。CLIがない場合はskipと表示する。
サービス起動・再起動テストは別扱いで、claim後にExcubitorからプロジェクト本体のみを起動する。

## 残る運用確認

作業ブランチの成功は本体への反映成功ではない。ネイティブPreCompact/復帰、Discord配送、
MCP認証切れ、実運用の契約観測は、対応する実イベントを得た時に初めて確認済みとする。
設定snapshotの公式整合性APIは供給された項目だけを見る。全クライアント設定の自動収集は含まない。
