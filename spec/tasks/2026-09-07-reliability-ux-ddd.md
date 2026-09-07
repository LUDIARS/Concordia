---
title: Cc の運用レビュー5件の修正と UX・DDD 開発方針
type: task
service: concordia
---

# Cc の運用レビュー5件の修正と UX・DDD 開発方針

## 実装内容

ユーザーから依頼されたレビュー指摘 1〜5 は Sol が担当する。対象は Issue 受付中断からの復旧、
委託キュー終了時の実行中処理の保全、lease 喪失時のワーカー停止、上限警告の配達状態、
cost 投稿と activity 通知の失敗分離。

並行して、Pf と Anatomia が共通参照する FORMAT_UX 形式で、プロダクトとコア候補2領域の
UX 定義書を Cc の `spec/ux/` に作成する。安定した文書・価値・シナリオ ID と、失敗からの
回復、未測定の条件、境界の理由を記載し、既存のドメイン `specRefs` に接続する。

今後 DDD で実装する方針を `spec/architecture/ddd.md` に記載し、ルート `AGENTS.md` と
README/spec index から参照させる。業務用語・状態所有者・不変条件から実装を始め、
domain の判断、application の手順、adapter の I/O、runtime の資源寿命を分離する。

## 受け入れ条件

- 受付済み Issue を Cc 再起動で見失わず、起動結果不明時には重複起動せず照合・確認へ進む。
- queue 停止時は新規取得を止め、進行中の起動結果処理を完了してから lease/DB を解放する。
- lease 失効・所有権喪失後に旧ワーカーが新しい処理を始めない。
- 警告の送信失敗は通知済みにせず、activity の失敗が cost 投稿の複製を起こさない。
- UX の価値 ID → シナリオ → 業務不変条件の対応を辿れ、draft と人間承認・実測を区別できる。
- コア候補2領域の UX を既存 domain の specRefs から参照でき、AGENTS.md から今後の DDD 手順を辿れる。

## 検証・完了範囲

ユーザー指示により、テスト・起動・再起動は実行しない。必要な回帰テストの更新と静的な
差分・参照確認を行い、実行結果を捏造しない。UX の人間承認、Pf への登録・実機確認、
DDD の全コード移行完了や新規の自動強制ゲート稼働は主張しない。

Migration 96 の台帳値は、TypeScript AST 内の SQL 文字列から CREATE / ADD COLUMN /
RENAME / DROP を静的に再構成して算出した。変更前の再構成値が既存の version 95 の
`SCHEMA_FINGERPRINT` と完全一致することを確認してから、新しい本文ハッシュ列を追加した
定義の指紋を算出している。アプリの migration 関数や SQL は実行していない。

静的確認として、`tsc --noEmit` を `tsconfig.json`、`tsconfig.test.json`、
`web/tsconfig.json` に対して実行し、いずれも通過した。テストコードの型確認は
テスト実行結果とは別であり、単体・統合・動作・起動テストは未実行。

作業は Concordia の main 起点の専用 worktree 内で行う。commit と Revisor local PR 作成までで
停止し、セッション自身によるマージ・main 更新・サービス反映は行わない。
