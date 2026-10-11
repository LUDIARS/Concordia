# デイリーゴールの Git 証跡引数の保護

- Actio: actio:5a49185e-ef65-4453-ba47-10a08b8102ae
- 価値: UX-CC-W9 / UX-CC-S10。証跡の読取りで作業ファイルを変更しない。
- 境界・所有者: daily-goal-run の証跡 adapter。CC-DG-INV-03、CC-INV-04。
- 用語: branch はセッションに保存されたブランチ名、unavailable は取得できなかった情報源。
- 再利用: parseSpawnBranch を採用。既存検証を利用し、空白による正規化とドットで始まる ref 構成要素を追加で拒否する。Revisor 照会は既存どおり。
- 復旧: セッションの branch を有効な値へ修正後、次の証跡収集で再取得する。DB 変更なし。

## 受け入れ条件

C-17 evidenceGitArgs(branch, since): 不正な branch は null、受理した branch は --end-of-options 直後の単一 revision として返す

## 作業と検証計画

- [x] 契約と述語を実装前に登録。
- [x] Git 実行前の検証とオプション終端を追加。
- [x] 正常な引数配列、不正 branch の Git 未呼出し、unavailable、PR / Actio / Revisor の継続を回帰テストに追加。
- [x] augur plan の現挙動固定方針に沿い、注入済み port で正常系と拒否系を比較するテストを記述。
- [x] 本体 typecheck 成功。テストを含む typecheck は対象外 6 件のエラーで失敗 (今回のファイルの診断なし)。
- [x] 契約組込みは対象 1 ファイル。contracts lint の C-17 指摘なし (既存契約 9 件の指摘あり)。
- [x] git diff --check 成功。契約 C-17 は calls 0 / observed 0 / violations 0。
- [ ] Concordia にコミット依頼し、Revisor local PR を提出。
- [ ] Revisor のマージ完了通知を確認。

テスト・起動・デプロイは依頼の禁止に従い未実施。実行契約の未観測を充足済みと報告しない。
