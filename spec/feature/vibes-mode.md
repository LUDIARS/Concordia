---
type: feature
title: "バイブスモード — 動作中のものをいじりながら確認する軽量レーン"
description: "UI 調整や簡単な機能追加を、testing claim の機械的裏付けの下で本体フォルダ + 作業ブランチで反復するレーン。受け入れ条件は『人間の目視 OK』。時間・スコープ上限つきで、終了は commit → PR → claim release → 決定論終了に合流する。"
service: concordia
domain: governance
tags:
  - vibes
  - testing-traffic
  - harness
  - excubitor
  - lifecycle
status: planned
related:
  - feature/session-contract.md
  - feature/plan-gate.md
  - feature/testing-traffic.md
  - feature/deterministic-teardown.md
updated: 2026-08-13
---

# バイブスモード

> 2026-08-13 neco 指示。 すべてをプランモードで動かすのではなく、 UI 調整や簡単な
> 機能追加では動作中のものをいじりながら確認する「バイブス」モードを用意する。
> モードは初回指示後の自動判断 (session-contract) で入る。

## 0. 定義

バイブスモードは「プラン省略」ではなく、 **受け入れ条件が『人間の目視 OK』であるタスクの
専用レーン**である。 終了条件は必ずある (= 上長の OK 発言) という整理により、 plan-gate の
「受け入れ条件必須」と一貫する。

既存の絶対則 (worktree 動作テスト禁止 / セッション内サービス起動禁止 / 起動は Excubitor
経由のみ) は**緩めない**。 vibes は「testing claim という機械的裏付けがあるときだけ、
claim 対象サービスに限り条件付き allow」で成立させる。

## 1. 開始 (契約確定時)

契約が `mode: "vibes"` に確定すると:

1. Cc が対象サービスの **testing claim を自動取得** (`POST /v1/testing/claim`、 既存の
   テスト交通整備)。 取れない間はキュー待ちし、 セッションへ「claim 待ち」を通知する。
2. 作業場所は **プロジェクト本体フォルダ + 作業ブランチ** (`work_location: "repo-root"`)。
   worktree は使わない (Unity ルール「動作フォルダで切替」と同方式。 main/develop への
   直コミット禁止は維持)。
3. サービス起動・再起動は **Excubitor 経由のみ** (現行どおり)。 反映は
   web-reflect-without-restart の判定 (直接配信 / ビルドのみ / 再起動) に従い、
   不要な再起動を避ける。

## 2. ハーネス (条件付き allow)

- `no-op-test-in-worktree` / `no-service-start-in-session` (task-workflow §4.1) に、
  「**有効な vibes claim を持つセッション × claim 対象サービス**」の組に限る allow 条件を
  追加する。 無条件に deny の例外を開けない。 claim の実在は Cc の testing state から
  決定論で解決する。
- スコープ: 契約の `scope_dirs` 外の編集は deny (session-contract §4 と共通述語)。
  UI をいじるつもりが migration に触れたら機械で止まる。 migration / schema / 認証 /
  削除系ファイルは scope_dirs に含めても deny (seed 側で plan 固定の対象なので、
  vibes 契約に混入していたら契約不整合として再判定に送る)。

## 3. 上限 (暴走防止)

| 上限 | 既定 | 挙動 |
|---|---|---|
| claim 時間 | 60 分 (`CONCORDIA_VIBES_CLAIM_SEC`) | 満了で inquiry (category=タスク) を送り、延長はお伺い経由。応答なしなら claim release + blocked |
| 編集ファイル数 | 20 (`CONCORDIA_VIBES_MAX_FILES`) | 超過で「plan へ昇格するか」を質問カードで確認 |
| 昇格 | — | 大ごと判明時は契約更新で plan へ (plan-gate §5)。 claim は release |

## 4. 終了

反復が収束したら通常フローに合流する:

```
上長の OK (Discord 発言 or 状態カードの [OK] ボタン)
  → commit → PR 作成 (vibes でも PR 必須。 OK 発言の引用を PR 本文に受け入れ条件充足として記録)
  → claim release
  → completed 報告 → 決定論終了 (deterministic-teardown)
```

- OK 発言の紐付けは決定論で行う: 状態カードの `[OK]` ボタン、 または vibes セッションの
  スレッドでの上長の「OK」返信 (requester 判定は既存 ingress の仕組み)。
- OK が出ないまま claim 上限に達したら §3 の経路 (blocked + release)。 作業内容は
  ブランチに残るので、 再開は新しい契約 (再 claim) で行う。

## 5. 受け入れ基準

- [ ] mode=vibes の契約確定で testing claim が自動取得され、 claim 中のみ対象サービスの
      起動系コマンドが allow される。 claim が無い同種セッションは従来どおり deny。
- [ ] scope_dirs 外・migration/schema/認証/削除系の編集が deny される。
- [ ] claim 時間上限で延長お伺いが飛び、 応答が無ければ release + blocked になる。
- [ ] 上長の OK → commit → PR → release → completed → 決定論終了まで人手の追加操作なしに
      一本で流れる。 PR 本文に OK の記録が残る。
- [ ] vibes → plan 昇格で claim が release され、 設問フェーズに入る。
