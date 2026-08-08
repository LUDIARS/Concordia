---
task: config-env-read-consolidation
project: Concordia
kind: 実装
status: done
created: 2026-08-09
source_session: lictor-cda8a337-d0f2-47ee-aa8a-639329b9fd55
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/setup/config-reference.md
---
# env 直読みの重複を src/config 設定レイヤーへ集約 (実施済み / W5 とは別物)

## 経緯 (重要)

このタスクは **委託 W5 の成果物ではない**。 セッションが委託 run の args を読まず
branch 名 `feat/settings-consolidation` から作業内容を推測して着手してしまったもの。
成果自体は独立して成立しているので記録として残すが、 W5
(WebUI に出ていない設定を全て表示し設定ページに集約する) は**未着手**であり、
`2026-08-09-settings-registry-core.md` 以下 3 件が残作業。

ただし本タスクの成果は W5-1 の土台になる: env 読み出しの正本が `src/config/` に
1 箇所化されたので、 レジストリの 「env 名」 「現在値」 「出所」 はここから引ける。

## 目的

同じ env キーを複数モジュールが個別に読み、 既定値とパース規則がファイルごとに割れていた。
2 箇所以上から参照されるキーの読み出しを設定レイヤーへ寄せる。

## 完了条件 (達成済み)

- `src/config/` に SRP で分割した 5 モジュールを新設
  (`env-parse` / `workspace-roots` / `service-urls` / `attachment-policy` / `claude-availability`)。
- 解消した食い違い:
  - ワークスペースルート解決の 3 重実装 (dedupe する版としない版が混在)
  - Excubitor base URL の参照キー不一致 (`EXCUBITOR_URL` を片方しか見ていなかった)
  - 同一既定値の `DEFAULT_BASE(_URL)` が 8 ファイルに重複定義
  - `CONCORDIA_DISABLE_CLAUDE` の 4 経路個別判定
  - 添付パス許可を chat 受信側と Discord 送出側が個別に読んでいた (入口と出口で境界が割れる)
  - 空文字 env が base URL として採用され得た (`??` と `||` の混在) → 全経路 「未設定」 扱いへ統一
- `spec/setup/config-reference.md` を実装に追随。 未記載だった兄弟サービス URL 7 キーと
  添付ポリシー 2 キーを追加。
- `npm run lint` (tsc x2 + dependency-cruiser) green。

## 残り

- 新規ユニットテストは追加のみで**未実行** (セッションポリシーによりテスト実行は指示待ち)。 CI で検証。
- Revisor local PR #343 提出済み。 レビュー / チェック結果待ち。
