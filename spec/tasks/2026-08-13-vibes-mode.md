---
task: vibes-mode
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/vibes-mode.md
  - spec/feature/testing-traffic.md
---
# バイブスモード (claim 自動化 + 条件付き allow + 上限 + OK 終了)

## 目的
UI 調整・軽微な機能追加を testing claim の裏付け下で本体フォルダ反復できるようにする
(vibes-mode 全節)。

## 完了条件
- mode=vibes の契約確定で対象サービスの testing claim が自動取得され、待ちが通知される。
- claim 中のみ `no-op-test-in-worktree` / `no-service-start-in-session` が
  「claim 保持セッション × claim 対象サービス」の組に限り allow になる。
- scope_dirs 外・migration/schema/認証/削除系の編集が deny され、混入は契約再判定に送られる。
- claim 時間上限 (`CONCORDIA_VIBES_CLAIM_SEC`) で延長お伺いが飛び、無応答で
  release + blocked になる。編集ファイル数上限で plan 昇格確認カードが出る。
- 上長 OK (`[OK]` ボタン / スレッド返信) → commit → PR (OK 記録つき) → release →
  completed → teardown ladder が一本で流れる。
- claim 分岐・allow 判定・上限・終了経路の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/harness/
- src/control/
- src/taskflow/
- src/discord/
- src/config/settings/
