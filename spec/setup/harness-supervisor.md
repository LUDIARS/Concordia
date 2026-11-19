# 独立ハーネス監督スクリプトの配置

`npm run build:harness`はサービスを起動せず、Node標準ライブラリだけで動く`harness-runtime/`を生成する。
このディレクトリ全体を安定した配置先へコピーする。Ccのソース・DB・node_modulesを参照しないため、
Ccが停止しても使用できる。生成物はgitに保存しない。

設定JSONには以下を指定する。絶対パスは配置環境に合わせる。

- `catalog`: サービス所有の`Concordia/excubitor.catalog.yaml`の絶対パス。portは毎回ここから解決する。
- `stateDir`: オフライン監査とポリシーキャッシュの専用ディレクトリ。
- `recoveryRoots`: 復旧実装を許可するリポ本体またはworktreeの絶対パス配列。部分一致では許可しない。
- `recoveryCommands`: 復旧に使うコマンド文字列の配列。前後空白を除いた完全一致で判定する。

復旧コマンドは診断・ビルド・許可済みのExcubitor操作に限定して運用者が指定する。
スクリプトがサービスを起動することはない。許可されたコマンドも既存のGit・起動・テスト規則で判定する。
実行する主体の人間による許可をこの設定で捏造しない。

PreToolUse hookの呼び出し先を次に切り替える。

```
node <配置先>/harness/supervisor-cli.js <設定JSONの絶対パス>
```

stdinは既存hookと同じ`tool_name/cwd/tool_input`、セッションは`LICTOR_SESSION_ID`を使う。
既存の中央依存`harness-gate.mjs`を残したまま追加すると、旧hookがCc停止時に拒否するため解消しない。
**実際に有効な既存hookを置き換える。** Castra管理hookの変更はCastra側の権限・共有差分確認が必要。
置換用の薄いhookは`tools/harness-gate.mjs`にある。既存と同じ`CONCORDIA_HARNESS_HOOKS=1`で有効になり、
`CONCORDIA_HARNESS_RUNTIME`に生成物の配置先、`CONCORDIA_HARNESS_CONFIG`に設定JSONの絶対パスを指定する。
Codex等で別のhookプロトコルを使う場合は、そのproviderの入口で同じaction契約へ変換する必要がある。

## 判定と制約

- オンラインのdenyと不正な成功応答はオフライン許可で置換しない。
- ゲート応答は2秒待ち、返らなければCcの`/health`を1秒以内で確認する。`/health`が応答すればCcは稼働中で処理が遅いだけとみなし、ゲート応答を1回あたり最大15秒まで待つ(2026-10-12実測のゲート処理 p99 11.2秒を覆う値。無制限には待たない)。`/health`も応答しなければその時点で通信失敗として扱う(Actio 878c4db5 / #29)。
- 通信失敗・タイムアウト・5xxのときは、同一repo・origin群・branch・sessionの15分以内のキャッシュを使用する。
- 稼働中なのに上限内に返らずキャッシュも無いときは`slow`として監査に記録する。許可範囲は復旧範囲と同じで広げず、拒否理由は「Cc停止」ではなく「再試行で通りうる遅延」と区別して示す。
- キャッシュはオンラインで解決した契約・チーム等の状態と決定的規則の判定に使う。学習器への問い合わせは行わず、中央の最新変更を即時に知ることはできない。
- キャッシュ不成立時は明示した復旧範囲だけ許可する。キャッシュで追加の契約要件に止められる場合も、復旧対象なら基礎規則を維持して判定する。
- 問診のread-only状態が記録されている場合は期限切れでも復旧権限に置き換えない。初回未取得のセッション権限を推測できないため、復旧設定を問診など権限の異なる実行環境と共用しない。
- オフライン使用でキャッシュ期限は延長しない。再接続時に最新設定を取得する。
- 対応する編集ツールでDDDのUX文書とdomain membershipを確認する。shell内の任意プログラムが書く全ファイルを検出するサンドボックスではない。
- 設定のチェックは編集ゲートへ即時反映する。セッション契約の初期生成は選択済みプロジェクトの起動・task変更時に行う。
- 拒否・warn の文は `[種別] 説明` の形で出し、原因が複数あるときは ` / ` で並べて全部出す (例: `[cc_unreachable] … / [cache_expired] …`)。監査 `audit.jsonl` には `failure_kind` (種別の配列) を記録する。種別は表示と監査のためだけに使い、許可/拒否の判定は変えない。
- gate がリポ文脈を解けない既知の失敗 (`ImplementationBindFailure`。detached HEAD は `unnamed_branch`) は素の 5xx にせず、`{ decision: "deny", blocked: true, reason: "[cc_error] …", error: "<reason>", stage }` の明示応答で返す。deny のまま緩めず、`local_policy` を返さないのでキャッシュも更新しない。

### 失敗の種別 (`src/harness/gate-failure.ts`)

| 種別 | 意味 |
|---|---|
| `cc_unreachable` | gate も `/health` も応答しない (接続拒否・応答なし) |
| `cc_slow` | `/health` は応答したが gate が上限内に返らない (再試行で通りうる) |
| `cc_error` | gate が 5xx を返した。本文の `error` / `reason` / `stage` があれば含め、無ければ HTTP status。gate が理由付き deny の `error` を返した場合も監査に記録する |
| `cc_invalid_response` | 200 以外の 4xx、または 200 だが形式不正 |
| `local_git_failed` | hook 内の git 呼び出しの失敗。git の操作 (例 `rev-parse --show-toplevel`) と timeout / exit code / git 不在を示す |
| `cache_expired` | キャッシュが 15 分を超えた (または未来時刻) |
| `cache_session_mismatch` | 別 session のキャッシュ (または `LICTOR_SESSION_ID` が無い) |
| `cache_branch_mismatch` | 別 branch で取得したキャッシュ |
| `cache_corrupt` | キャッシュが読めない・形式不正・キーと repo が一致しない |
| `cache_missing` | キャッシュファイルが無い |

キャッシュ不成立の理由は `snapshotUnusableReason` で判定し、`usableSnapshot` はその結果が null のときだけ真とする (診断と権限判定が食い違わない)。
- 監査にはコマンド本文やプロンプトを残さない。キャッシュ・監査の配置先は運用者と当該アカウントだけが編集できるよう管理する。

この文書の追加は、全プロジェクトへのhook配置や稼働環境への反映完了を意味しない。
