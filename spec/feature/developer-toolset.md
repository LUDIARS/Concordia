---
title: Cc 共通開発ツールセット
status: draft
service: concordia
---

# 目的と契約

2026-09-25 neco 指示。Cc はハーモナイザーであり、共通作業を実行するツールセットでもある。
繰り返す操作は型付きツールへ、選択手順と結果の解釈はスキルへ置く。
UX-CC-W1/W2/W4/W5、S1/S3/S5/S6: 作業対象を取り違えず、未準備・失敗・結果不明を区別し、次に必要な準備が分かる状態を守る。
CC-INV-01/02/03/04/05 を適用する。

## 状態所有者

- Git と既存 implementation-tools: checkout、所有 worktree、session binding。
- Actio: タスク本文・状態・依存・クリティカルパス。Cc は別のタスク台帳を作らない。
- Pf: 仕様、Anatomia: 実装索引と影響調査、Augur: 登録テストと実行結果。
- Cc harness: Bash を含む実行前判定。チェックの成功は実行許可を追加しない。
- developer-tools: 許可された操作のカタログ、型検証、既存所有者への接続、準備不足の案内。

## CC-TOOLS-01: 共通入口

MCP と HTTP は同じ入力スキーマと操作定義を使う。任意 URL・任意 shell の代理実行は受け付けない。
MCP は自身の Lictor session を取得する。HTTP は既存の loopback 信頼境界を維持する。
対象は active session の登録 checkout から決め、workspace 内の実 Git root と branch を照合する。
ツール一覧は有効箇所、必要な連携、API/CLI 代用、準備条件、副作用を返す。
公開済みの能力と現在接続できる能力を区別する。

## CC-TOOLS-02: 連携と準備

Actio は既存 binding・認証・owner/team/source 検査を維持する。
Pf/An の project は登録対応を照合し、名前の類似で推測しない。
未登録、停止、認証不足、未解析、CLI 不足には reason と next_action を返す。
準備確認はインストール・サービス起動・設定書換え・他者への連絡を自動実行しない。
MCP 接続がない場合も同じ機能の HTTP/CLI adapter が使える。存在しない API を成功として代用しない。

## CC-TOOLS-03: 変更と検証

既存 worktree 切替は Git が持つ別 checkout へ session を移し、共有 checkout を switch/reset しない。
タスク更新は対象 reference と scope を検査する。通信失敗は結果不明として再取得を促す。
Augur テストは登録 bundle を指定し、空 bundle を成功扱いしない。実行には人間の許可根拠を必要とする。
脆弱性確認は対応する lockfile の固定バージョンを照会し、未対応形式・照会失敗を未検証とする。
重い操作は期限・出力上限を設け、同一依頼の結果不明を再実行で隠さない。

## Castra からの移管

対象は .claude/hooks/harness-guard.mjs の既知危険コマンド検査、harness-gate の呼出手順、
Anatomia supply/verify と手書きの連携 HTTP 手順。Cc が判定・adapter を所有し、スキルは薄い利用手順を持つ。
古い hook の削除や全端末設定の変更は、同等判定と接続先の確認後に行う。未移行端末を移行済みと記載しない。

## 受入・公開

## CC-TOOLS-WEB-01: WebUI の確認画面

`/developer-tools` は HTTP と同じ能力カタログを表示し、名前・提供元で検索できる。
有効箇所、MCP名、HTTP入口、準備条件、副作用を表示する。取得失敗を空の成功にせず再読込を提供する。
カタログ掲載と実接続の成功を区別し、閲覧だけでツールを実行しない。
状態所有者は developer-tools/catalog、表示は http-interface。UX-CC-W1/W4/W5、CC-INV-01/04。

## CC-RWF-DATA-01: ローカルデータによる拡張

RWF の実行エンジンは Concordia 本体が所有する。外部リポジトリの JavaScript は読み込まない。
拡張はローカルスキルの `metadata.rwf` と既存 custom-reaction-workflows.json に置く。
同梱の初期例は設定画面で確認し、存在するローカルスキルへ追加する。未導入スキルは準備不足を表示する。
追加は既存の絵文字割当を上書きせず、削除済みの設定を起動時に復活させない。
予約絵文字、action に基づく認可、実行者・対象セッションの照合は従来通り本体が判断する。
旧 plugin path の指定があれば廃止を通知する。旧リポジトリ自体の削除は行わない。
状態所有者は既存 RWF store / skill catalog、既定値は本体の宣言データ。CC-INV-01/02/04。

ツールの登録・HTTP/MCP 同等性、他 session/別 repo の拒否、準備不足、結果不明、Bash の危険操作、
Actio scope、外部サービス障害、Augur の不合格と空 bundle を回帰確認する。
source/tests は cc.acceptance.json に対応付ける。Anatomia verify と登録テスト、
プロジェクト本体での動作確認後に Revisor 経由で 3.0 として公開する。
テスト・公開の許可根拠はこの会話の neco「これを実装して動作確認出来たら3.0としてメジャーリリースする」。
この仕様自体は実施済み・公開済みの証拠ではない。

## 実装途中の証跡（2026-09-26）

`feat/common-command-tools` で作業継続。人間の開始指示と Cc implementation revision 3 を照合した。
Pf の Anatomia 登録 ID 対応、OSV の部分検証表示、受付時の許可根拠保存、関連テストと受入対応を追加した。
追加修正後の回帰・型検査・Anatomia verify は未実施。自動確認を検証・マージの許可として扱わない。
先行した実接続確認の Anatomia は `service_unreachable` で終了し、成功証跡には含めない。
本体への反映、実機確認、Revisor 提出・マージ、3.0 リリースは未完了。
