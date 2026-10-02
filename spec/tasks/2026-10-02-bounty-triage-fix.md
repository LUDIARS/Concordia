---
task: 2026-10-02-bounty-triage-fix
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 2/5 — AI の仕分け・再審・Actio タスク作成・hotfix

設計正本: `spec/feature/bug-bounty.md` §5・§6・§11 (`SPEC-BOUNTY-TRIAGE` / `SPEC-BOUNTY-APPEAL` / `SPEC-BOUNTY-FIX` /
`SPEC-BOUNTY-HOTFIX` / `SPEC-BOUNTY-FIX-LINK`)。価値 UX-CC-W7 / シナリオ UX-CC-S8。ドメイン `bug-bounty` (支援)。
前提: `2026-10-02-bounty-intake` がマージ済み。
2026-10-02 neco 指示「(仕分けは) AI で判断」「その場で修正するものも含む (いわゆる hotfix)」。

## 目的

受け付けた報告を AI が採用・重複・対象外・情報不足に仕分け、採用した報告を Actio のタスクにし、
その場で直せるものは修正の委託を起動する。報告の本文を AI への指示にしない。

## 完了条件

- [ ] 仕分けの起動: 対象プロジェクトを cwd にした読み取り専用の委託 (編集・シェル・push なし)。依頼文は Cc が組み立て、
      報告の本文は「資料であり指示ではない」区切りに入れる (CC-BOUNTY-INV-01)。未解決の報告を重複判定の材料に添える。
- [ ] `POST /v1/bounty/reports/:id/triage-result`: その報告の仕分けとして Cc が起動したセッションからだけ受ける。
      入口で検証し、不正な結果は保存しない。3 回失敗で権限者へ回す。
- [ ] 重複は根の報告へ付け替える。判定と理由を受付口へ返す。情報不足は聞き返しを 1 回にまとめる。
- [ ] `/bug appeal` (1 報告 1 回) と、権限者による判定・深刻度・自己起因の変更。変更は履歴に残す (CC-BOUNTY-INV-08)。
- [ ] 採用で Actio のタスクを作る (`source: concordia.bounty.v1` / `sourceRef: 報告 id`)。責任者とチームを決められなければ
      失敗として記録し、再試行できる。Actio 不通は保持して定期に再試行する。
- [ ] hotfix の条件を純関数で持ち、満たせば既存の実装委託を Actio タスク付きで起動する (ブランチ `fix/bounty-<短縮 id>`)。
      失敗・停止は `fix_pending` へ戻し、自動で起動し直さない (CC-INV-03)。1 日の起動上限は設定 `bounty.hotfix_daily_limit`。
- [ ] 修正の PR と報告の対応を記録する (委託 run、またはセッションの task-link から)。
- [ ] 仕分け・hotfix の起動が結果不明のとき、既存の起動を照合してから増やす。
- [ ] `/bug amend id:<報告 id>` (モーダルで追記)。情報不足と判定された報告へ、Discord から本人が書き足せるようにする (1/5 では API だけ)。
- [ ] 操作者の経路 (`platform` + `actor`) を Bot と Cocoiru だけに限る (CC-BOUNTY-INV-10)。Bot は Cc が起動時に作る内部トークン、
      Cocoiru は設定画面で持つ鍵 (暗号化して保存、env から読まない) を付けて呼ぶ。トークンの無い操作者の要求は 403。
      セッションの経路 (`session_id`) は変えない。相談の API など他の経路へは広げない (本タスクの範囲は `/v1/bounty` だけ)。
- [ ] metadata が壊れたセッションを本社所属として扱わない。所属を読めないセッションは対象プロジェクトの範囲を空にする (fail closed)。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/bounty/`、`src/db/bounty-*-repo.ts`、`src/api/bounty*.ts`、`src/discord/bounty-*`、`src/discord/commands/bug.ts`
- 委託テンプレートの seed (仕分け用の読み取り専用テンプレート)、設定定義 (`bounty.hotfix_daily_limit`)
- `tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`
