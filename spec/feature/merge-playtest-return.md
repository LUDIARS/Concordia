---
id: CC-MERGE-RETURN
domain: conflux-integration
status: draft
---

# マージ後のビルド・再試遊帰還

Actio `f69c01a2-02e0-4969-83c3-88e8d7d296f1`、帰還トリガ `3a815e1d`。
UX-CC-W5/W11・UX-CC-S6/S12、CC-INV-03/04/06/07。
Revisor PR がマージされたら、設定したプロジェクトのマージ先コミットをビルドし、
Muse に同じコミットの試遊を依頼できる。Revisor が PR の採否とマージ結果を所有し、Conflux がビルドの実行結果、
指令ブリッジが Muse の指令と実行結果を所有する。帰還台帳はそれらの受付を照合するための記録を持つ。

- CC-RET-INV-01 `CONCORDIA_MERGE_PLAYTEST_RETURN` は登録済み Cc プロジェクトコードをキーとする JSON オブジェクト。
  値は `{ "platforms": ["windows"], "agent": "muse" }` の形で、`agent` は省略可。未設定は無効。
  Conflux ワーカーは登録済みの統合通知対象と、帰還を有効にしたプロジェクトのマージ済み PR 一覧を観測する。
  登録プロジェクトの origin と PR の repository を照合する。有効化時刻は保存し、一覧の決着時刻 (`updatedAt`) が
  有効化より前の PR を対象外とする。統合通知だけが設定されたプロジェクトでは無効化の観測を台帳に残す。
  ビルドには当該プロジェクトの Conflux Flow 有効化とビルドランナー設定が必要。
- CC-RET-INV-02 PR の head SHA とマージ後の SHA を区別する。同一 `(project_code, merge_commit_sha)` で払い出しは一度。
  起動前に既存の自走ループ遮断状態を確認し、遮断中は理由を保存して両方の受付を見送る。
- CC-RET-INV-03 ビルド依頼と Muse の `playtest` 指令を帰還受付と同じ SQLite トランザクションで保存する。
  指令には `project_code`、`merge_commit_sha`、`branch`、`dedupe_key` を渡す。
  受付後はビルドキューと Muse のポーリングで独立に進む。Muse は同じキーの再配信を照合し、ビルドが必要なら結果を確認してから試遊する。
  ビルドランナーはマージ SHA がマージ先ブランチの祖先であることを確かめ、専用 worktree で実行する。
- CC-RET-INV-04 `GET /v1/control/merge-playtest-returns` は loopback の管制 API 上で直近 100 件の受付・スキップを返す。
  同じマージを複数の連携が観測した場合もスキップを記録する。保存が中断された受付は次の観測で再試行する。
  保存済みの遮断・無効・設定不備はその観測の終端。途中で停止したビルドは Conflux の既存の失敗記録で照合する。
  各記録の `build_mode` は `conflux` (ビルド依頼あり)、`agent` (エージェントが自分でビルド)、`null` (払い出し無し) を示す。
- CC-RET-INV-05 値の `build` は省略可の真偽値で、既定 `true` は CC-RET-INV-01/03 のとおり Conflux ビルドを依頼する。
  `build: false` のプロジェクトは Conflux ビルドを依頼せず、Conflux Flow 有効化とビルドランナー設定も要求しない。
  帰還受付と Muse の `playtest` 指令だけを同じトランザクションで保存し、CC-RET-INV-02 の一度だけの払い出し・遮断確認・dedupe は維持する。
  指令の params には CC-RET-INV-03 の項目に加えて PR の `repository` (org/name) と `build: "agent"` を入れ、
  本文で「このコミットを自分の環境で取得・ビルドしてから遊び、感想を result で返す」ことを依頼する。
  受付記録の `build_key` は `null` で、`build_mode` は `agent` になる。
  実装: `src/conflux/config.ts` (設定検証)、`src/conflux/merge-return-service.ts` (受付)、
  `src/conflux/merge-return-instruction.ts` (指令本文)、`src/conflux/merge-return-repository.ts` (`build_mode` 判定)。
  契約 `gen5-return-C-4` の述語は `src/conflux/merge-return-instruction.contract.ts` に置く。
  Amicii (`Ai`) は Muse が iMac で GitHub から取得してビルドするため `build: false` で有効化する (neco 2026-11-23、Actio `4ce26882`)。

- 再試遊の指令 (type `playtest`) に Muse が `done` で返す result に `detail.review` があれば、Cc が Voluptas へ保存して
  本社の宛先へ告知する ([AI プレイテスト感想の投稿](playtest-review-notify.md) の「Muse の結果の中継」、形は
  [指令ブリッジ](agent-instructions-bridge.md) の「playtest の結果」)。帰還台帳は中継の状態を持たない (所有者は中継台帳 `muse_playtest_relays`)。

移行 153 は台帳と外部連携の結果列を追加する。帰還受付を止めるにはプロジェクトを opt-in 設定から外す。
保存済みの指令・ビルド結果と帰還履歴は運用確認に使う。ロールバック時も履歴テーブルを保持する。
