---
type: feature
title: "プロジェクト登録後の実装ポリシー / ルール inject"
description: "セッションが作業対象プロジェクトを登録した直後に、そのプロジェクトが正本として持つ実装ポリシー / ルールの本文を Cc がセッションへ届ける。複数プロジェクトに広がった場合も、加わったプロジェクトごとに届ける。"
service: concordia
domain: session-coordination
status: implemented
related:
  - ./shared-startup-context.md
updated: 2026-09-29
---

# プロジェクト登録後の実装ポリシー / ルール inject

## 依頼

neco 2026-09-29「プロジェクト登録が終わった後、Cc からプロジェクトに関する実装ポリシー/ルールを Inject して。複数のプロジェクトになる場合も同様」。Actio task `actio:3653ffd0`。

## 背景

起動案内 (`[Cc policy update]` の resources) は、対象プロジェクトの AGENTS.md や rule 索引の**パス**を知らせるだけで、本文は届けていなかった。案内の対象も現在の 1 プロジェクトだけで、セッションが別のリポジトリへ広がったときにそのプロジェクトのルールは届かなかった。

## 振る舞い

- 契機: 起動案内の再計算 (`refreshStartupPolicy`) の後。登録 (PATCH / Lictor の task set) と、プロンプトごとの登録確認の両方で走る。
- 対象プロジェクト:
  - 登録が確定したプロジェクト (workspace root = Castra のままの起動直後は対象外)。
  - セッションが触った別リポ (`sessions.active_repos`) を project registry で引き当てたプロジェクト。
- 資料: プロジェクトの `AGENTS.md` (無ければ `CLAUDE.md`) と `rule/README.md`。1 資料 6,000 文字まで。超えた分は正本のパスを案内する。見つからない資料は「未読」と明示する。512 KiB を超えるファイルは読まない。
- 1 プロジェクト 1 通の inject (`source: cc-project-rules`、先頭行 `[Cc project rules] <code> (<root>)`)。
- 重複: 届けた内容のハッシュを `metadata.cc_project_rules_delivered[<code>]` に残し、同じ内容は再送しない。内容が変わったら「更新されました」として届け直す。

## 不変条件

- ルール本文の配送は実行許可を追加しない (本文にも明記する)。
- workspace root での起動直後は、登録が終わっていないため届けない。
- 読めない資料を読了扱いにしない。

## 復旧

- 配送を止める: `startup-policy-check.ts` の `deliverProjectRules` 呼び出しを外す。起動案内そのものは影響を受けない。
- 再送させる: 対象セッションの `metadata.cc_project_rules_delivered` から該当コードを消す。
