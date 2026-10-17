---
id: CC-CLOUD-GIT-RETURN
status: draft
domain: cloud-execution
---

# Gitを既定とするクラウド成果返送

neco 2026-10-16: 両経路を残す。既定はGit、S3はGitで履歴管理しない成果物の受け渡し・外部参照・アップロード用。推奨構成での実装と残件対応を承認済み。学校の技術相談は用途候補であり、相談フロー自体の変更をこの実装に混ぜない。
Actio: b0483e60-297d-4dc6-a4bf-54e1f8752e04。旧コミット6e845236はS3専用。147件テストと資料7.1の実物は未入手であり再利用済みとしない。

## 境界と使い分け

UX-CC-W3/W4、CC-INV-01/03/07/08。既存cloud-executionが返送能力、run token、隔離受信、受領記録を所有する。Revisorは既存local PRと審査を所有する。Ccの通常の委託受付・予算・Actio所属・二重依頼防止を共用し、新規ドメインを作らない。
Gitは既定。S3は明示選択したtargetだけで使用し、Git失敗からS3へ切替えない。GitHubの公開済みmainの正確なcommitから準備し、成果はGitHubにpushせず専用受信先へ送る。GPU能力は従来どおり実証が必要。
既存のS3 run journalは旧configuration fingerprintで照合し、明示S3 targetがある場合だけ回収を続ける。旧設定ファイルは`transferMode: s3`を明示する移行が必要。未指定をS3と推測しない。

## 受信と認証

Cc所有の独立したloopback HTTP listenerを専用Tunnel/Access applicationに接続する。一般Cc APIやRevisor APIを公開しない。Access署名JWTの検証に加えrun tokenを検証する。Accessをtokenだけで代替しない。公開host、Access audience/issuer、秘密のbindingは運用設定として別途確認し、実装だけでDNS/Accessを変更しない。
受信先はrunごとのbare repository。元repo、target、attempt、割当branch、source SHA、有効期限、上限を固定する。tokenは乱数で発行しhashだけ永続化。HTTP認証のために使い、URL/remote設定/ログへ埋め込まない。
Git smart HTTPのinfo/refs(service=git-receive-pack)とgit-receive-packだけ受ける。GETでtokenを消費しない。POSTは割当branchへの新規作成1件に限定し、main/tag/delete/force/multiple-ref/shallow等を拒否する。受信packはGitのfsck、容量上限、期限、同時実行制限で検査する。HTTP200だけを受領成功としない。
書込前にrun単位の排他的受付記録を保存し、成功後は受領SHAと応答を保存する。同一requestの応答喪失には同じ受領結果を返すが別内容を再送しない。中断して結果不明なら受信refの照合が必要であり、lock削除で再実行しない。

## 取り込みと審査

Ccが受領SHAのsource ancestryを確認してから、登録checkoutへローカルのGit objectを取り込み、checkoutされていない固有branchをcompare-and-swapで作成する。既存branchを上書きしない。
取り込み前にGit treeから指定成果物の存在・通常ファイルであること・合計サイズを検査する。Blenderで開けることや外観の品質は別の実機評価であり、tree検査だけでは合格にしない。
既存direct local-pr-submissionを使用する。審査提出前にintentを永続化し、応答喪失は再送しない。受領・取り込み・審査提出・審査合格・反映は別状態。Actioを受領だけで完了にしない。
GitHub誤送信対策はremote push URL無効化と送信前チェックを重ねる。ただしエージェントが変更できる設定は強制的なネットワーク遮断ではない。providerのGitHub書込権限を制限できるかは両環境で未検証と明示する。

## 受入条件と復旧

Git/S3各経路の明示選択と既定値、認証失敗、token期限/所属/branch、再送/並行、pack/応答上限、HEAD一致、受領SHA祖先、既存branch保全、審査結果不明の再送禁止をテストする。実クラウドでのTokyo2070モデル生成は別途実行証拠を要する。
復旧: 新規受付を停止し、run journalと隔離repositoryを保持して照合する。既存branch・S3成果物を削除しない。公開設定やサービス起動の変更は実行前に具体的に確認する。

## 実装照合と検証記録（2026-10-17）

旧実装6e845236はS3署名URL生成・manifest検査・ローカル回収だけを持ち、Git受信やRevisor提出はなかった。
今回、同じcloud-execution境界にGit protocol検査、run token hash journal、隔離bare repo、Access検証付き専用入口、
ローカルref昇格と既存direct local PRへの接続を追加した。既存S3処理は明示選択で維持し、API/MCPのtarget選択で経路を選ぶ。
専用サービスはcatalogに追加したがautostart=falseであり、稼働・公開済みではない。

- Cloud/API/MCPの21ファイル148テスト通過。使い捨てローカルGit repositoryでbinary pack受信・SHA照合・再送結果照合を含む。
- WebのCloudWorkPanel 3テスト通過。NODE_ENV=productionを継承した初回実行はReact.actが使えず失敗し、NODE_ENV=testで再実行した。
- 既存のテスト全体の型検査は対象外15診断で失敗（既報Actio f47d9c8e-2cae-4aa9-825a-5702deadff0a）。全体の回帰合格とはしない。
- 両社クラウドからの実push、Accessヘッダ通過、Tokyo2070モデリング、GPU能力、公開設定、サービス起動、本体反映は未実施。
- 旧PR #3148のAWS公開サンプル署名キーに関する審査判断は通知待ち。今回の変更で検出文字列を隠したり審査ゲートを迂回したりしない。

設定待ち: Codex環境認証・環境ID、Claude routine/fire token binding、公開Git host/Access binding、Tokyo2070の最新サイズと準備証拠。
資料7.1と147件の別実装は未入手。今回の148件はこのブランチで実施した別の検証結果である。
