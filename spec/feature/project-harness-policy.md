---
type: feature
title: プロジェクト別DDD・契約適用と復旧可能なハーネス
service: concordia
domain: governance
---

# プロジェクト別の実装方針

UX-CC-W4（必要な判断だけを人間へ戻す）と、Cc停止から同じ仕事を復旧する価値を支える。
プロジェクト設定のDDDとセッション契約は独立したopt-in。状態所有者はCcのproject_codes。
未選択プロジェクトへこれらの追加要件を強制しない。既存の明示指示・問診の読み取り専用・
Gitやテストの安全規則を解除する設定ではない。

DDD適用時はUX・ドメイン・不変条件を定義してから実装する。機械判定は文書の存在と所属を
確認する入口であり、設計品質を保証するものではない。契約適用時はセッション契約の確定と
指定された承認・編集スコープをゲートで確認する。

## 障害時の監督処理

## コード実装の受入条件

project_codes が所有する `tests_required` と `ontime_tests_required` は既定falseの独立設定。
DDDは既存の `ddd_enabled` を使う。オンタイム必須時は通常テストの対応も要求する。
編集開始時にフックへ条件を提示し、提出前には変更コードとテストの対応を
`cc.acceptance.json` version 1 の `implementations`（source、tests、contracts）で照合する。
sourceはリポジトリ相対パス、testsは同じリポジトリ内の非空テストファイルへの参照、
contractsはAugur manifestの契約ID。対応表だけで実行成功・意味的品質を保証しない。
オンタイム契約は実装対象file、述語module、observeモードを確認する。
変更対象・証跡を取得できない場合は受入未確認とし、必須条件を満たしたと扱わない。
設定の有効化はテスト実行・再起動・デプロイの許可を追加しない。


Ccが応答する間は通常のゲート判定を使う。接続障害時の復旧経路を独立したスクリプトに分離し、
Cc自身のプロセスやDB接続を動作条件にしない。オンラインのdenyを障害扱いで迂回しない。
キャッシュは正本ではなく、対象repo・セッション・形式バージョン・取得時刻を照合する。
期限切れや破損、初回の未取得は明示する。復旧経路でも人間の許可や既存の破壊的操作禁止を維持する。
Ccへ再接続できたら最新の方針へ戻す。オフライン判定と復旧操作の監査をローカルに残す。


## 手順の注入

必須設定 (`ddd_enabled` / `contract_enabled` / `tests_required` / `ontime_tests_required`) が
一つでも有効なプロジェクトでは、旗の真偽値に加えて実装手順そのものを起動 inject と
着手前 supply (`POST /v1/harness/context`) に載せる。手順は価値 (spec/ux) → 所属
(spec/domains の membership と specRefs) → 契約 (work-phase の confirmation と人間の開始指示)
→ 実装 (src と tests を対、`cc.acceptance.json` の対応) → 検証 → 提出の順で、設定に応じて
該当する手だけを出す。注入は手順の提示であり、ゲート判定や実行許可を置き換えない。
ゲートの条件 (spec/ux 非空、specRefs 付きドメインの membership 一致) も同じ文で示す。
実装は `src/control/process-guidance.ts`。
