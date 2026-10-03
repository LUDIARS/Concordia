---
title: ローカル migration 番号衝突の事前確認
id: CC-MIGRATION-PREFLIGHT
status: draft
domain: tooling
---

# 価値と境界

UX-CC-W1/W3/W5、CC-INV-01/04/05。並行作業の開発者が、提出前に自分のコミットと
ローカル main・未マージ branch の番号衝突を確認する。Git が ref とソースの状態所有者、
tooling が比較結果の所有者。永続状態を作らず、失敗後は前提を直して読み直す。

「定義」は MIGRATIONS の各 object を TypeScript AST のトークン列にしたもの（コメント・配置用空白を除外）。
name/source/up の変更を含む。外部 helper の意味や baseline の変更を追跡するものではない。
意味的に同じ SQL や引用符でもソース文字列が異なれば別定義。番号は正の安全な整数リテラルに限定する。
共有祖先は一意な merge-base。複数祖先・祖先なし・schema 不在・構文不正・動的な配列や番号・
重複番号はエラー。schema は import/実行せず、既存 TypeScript parser で読む。

C-13 compareMigrations(left, right, ancestor): 同番号で定義が異なり少なくとも片側が祖先にない定義の場合だけ衝突を返す

CC-MP-01: Git 操作は rev-parse、for-each-ref、merge-base、show の読取のみ。
remote fetch、DB 接続、migration 実行、改番、baseline/checksum 更新、必須 gate は追加しない。
CC-MP-02: ref は最初に commit SHA へ固定し、結果に ref と SHA を含める。作業中の未コミット
schema は対象外。比較対象の取得や解析が一つでも失敗したら成功 0 件に変換しない。

# 使い方

開発依存を導入済みの Concordia checkout で `npm run migration:preflight -- [ref]`。
ref 省略時は HEAD。比較先はローカル `refs/heads/main` と、その main へ未マージの
local branch。自分と同じ SHA は省く。remote ref の自動探索はしない。
stdout は UTF-8 JSON（対象・比較先・祖先 SHA・衝突一覧）、stderr はエラー。
終了コードは 0=衝突なし、1=衝突あり、2=入力/取得/解析エラー。予約や排他保証はしない。
既定ではファイルも書かない。Augur の実行証跡が必要な検証者は `VESTIGIUM_LOGS_DIR` を
明示した場合のみ、そのディレクトリへ契約のメタデータを記録する（schema 本文は記録しない）。

# 設計と検証

tooling 配下の純比較、静的 parser adapter、Git adapter、application、CLI に分離する。
既存 migration-ledger は DB 実行と checksum 凍結の責務なので再利用せず維持する。
既存 TypeScript/tsx と Vitest を再利用し依存を追加しない。
Augur plan の正常系・公開契約・異常境界に沿って各層の対のテストを記述する。
この委託ではテスト実行を Revisor へ委ねる。人間承認・実機評価・契約通過を捏造しない。
