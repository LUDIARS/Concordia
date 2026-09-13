# Concordia の開発

対象プロジェクトは Concordia（Cc）。ユーザーの作業範囲・許可・完了指示を優先する。

## 変更前に読む

- [プロダクト UX](spec/ux/product.md)
- [Node.js 採用とサービス原則](spec/architecture/nodejs-service-principles.md)
- [DDD 実装方針](spec/architecture/ddd.md)
- 変更対象の `spec/domains/*.domain.json` と、そこから参照する feature / UX 文書

## 今後の実装は DDD で進める

- 最初に価値 ID、シナリオ、業務用語、状態所有者、不変条件を定める。
- 既存ドメインの所属と再利用候補を確認する。新規所属は実装より前に宣言し、src と tests を対で維持する。
- 業務判断は小さな純関数/ドメインポリシー、手順は application use case、外部 I/O は adapter に分離する。
- 新規の業務判断から transport SDK・DB 接続・環境変数に直接依存しない。既存コードは変更する境界から段階的に整理する。
- 他ドメインの状態を直接書き換えない。非同期処理は依頼同一性、結果不明時の照合、所有権喪失、停止時の結果保全を設計する。
- PR に UX 価値/不変条件 ID、対象境界、復旧方法、実施/未実施の検証を記す。

UX 文書は対象 repo の `spec/ux/` が正本。Pf/An へ別の編集可能なコピーを作らない。
LLM 作成の UX は draft とし、人間承認や実機評価を捏造しない。DDD 方針の追加を全コード移行済み・自動強制済みと報告しない。

## 作業と検証

実 branch を確認して Cc/Lictor に登録し、ローカル main 起点の task worktree で編集する。
未コミットの他者変更に触れない。テスト・サービス起動/再起動・マージはユーザーの明示的な許可範囲でのみ行う。
承認されたサービス操作は Excubitor 経由で本体フォルダから行う。
明示された終了条件に従い、PR 作成後に停止する依頼ではマージ・main 更新へ進まない。
