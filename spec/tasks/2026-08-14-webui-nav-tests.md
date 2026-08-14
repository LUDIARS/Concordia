---
task: webui-nav-tests
project: Concordia
kind: テスト
created: 2026-08-14
memory_links:
  - spec/tasks/2026-08-13-webui-sidebar.md
---
# WebUI サイドバーの表示切替テストを追加する

## 目的

2026-08-13-webui-sidebar の完了条件「表示切替 (デスクトップ / モバイル) のテストが
green」が未達。`web/src/components/Nav.tsx` を参照するテストが存在しない。

## 完了条件

- デスクトップ: サイドバー常駐と collapse 切替 (localStorage 永続・アイコンのみ表示)
  のテストが green。
- モバイル: hamburger → オーバーレイ開閉、route 変更 / Escape / backdrop クリックで
  閉じることのテストが green。
- web 側にコンポーネントテスト基盤が無い場合は、既存構成 (vitest) に合わせた
  最小構成の導入を含む。
- 既存の web ビルド・テストが green のまま。

## スコープ (編集可ディレクトリ)

- `web/`
- テスト設定ファイル (`web/package.json` / vitest 設定)
