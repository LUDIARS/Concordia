---
title: qs の安全な固定版更新
status: draft
task: actio:50d03d12-f65c-4a93-b6bc-2116e1324999
followup_task: actio:491e03ca-7bac-485a-9120-23b5702c1f02
---

既知の Medium 依存脆弱性の解消として qs 6.16.0 を 6.16.2 に更新する。
UX-CC-W5 / UX-CC-S6 の安全なサービス継続を支える依存保守であり、
業務状態・API・認可の変更はない。状態所有者は npm lockfile。

C-1 verifyQsLockUpdate(before, after): qs の version/resolved/integrity だけが指定の 6.16.2 に変わり、親要求レンジとそれ以外の lock 情報が維持される。

親要求は body-parser の ^6.15.2 と express の ^6.14.0。6.16.2 は双方の範囲内。
公開 npm registry の版メタデータで tarball と integrity を確認する。
qs 自身の依存要求も変わらず、overrides・親更新・major 更新は不要。

既存の tooling 境界に純粋な lock 差分検証と対のテストを置く。
Augur plan の現行動作の固定という提案に従い、対象更新の受理に加え、
別依存の更新・親レンジ変更・不正な integrity を拒否する回帰例を検証する。
復旧はこの変更の revert と既存の依存復元手順による。サービス操作は行わない。

既存 PR #3602 の審査記録では、5 件の assertion が成功していても登録名が
reporter の名前と一致せず、登録テストが未実行と判定された。
対象ファイル・契約・ドメインは維持し、登録名を対象ファイルのパスに合わせる。
登録 ID は Augur の既存の repository/file/name からの導出規則で再計算する。
Augur の既存のファイル単位集計を再利用し、5 件すべての失敗・収集エラーを判定対象にする。
スイート名の前方一致では先頭 assertion だけが照合されるため採用しない。
継続対応ではテストを実行せず、再提出後の Revisor に検証を委ねる。
