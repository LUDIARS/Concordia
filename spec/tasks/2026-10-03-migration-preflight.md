---
task: migration-preflight
project: Cc
kind: implementation
created: 2026-10-03
---

# migration 番号のローカル比較

Actio: `actio:41961650-0f50-4cfc-896d-fffbe5c715c2`

- 契約 C-13 と tooling 所属、価値・用語・不変条件を実装前に宣言する。
- Augur plan: 正常な衝突/継承比較、CLI の JSON/終了コード、解析不能/ref 不正/重複番号の境界を対のテストにする。
- 静的 parser、純比較、Git 読取、application、限定 CLI を実装する。
- テストは実行せず Revisor に委ね、Augur 未観測を未充足として記録する。
- Concordia に対象 path の commit を依頼し、local PR へ提出する。

復旧は CLI の変更を戻すだけで、DB やサービスに移行操作はない。

## 実装内容

UX-CC-W1/W3/W5、CC-INV-01/04/05、CC-MP-01/02。tooling 内に純比較、静的 parser、
Git adapter、application、CLI を追加。作業対象と比較先を SHA で固定し、解析不能をエラーにする。
既存 TypeScript/tsx/Vitest を再利用。migration-ledger は DB と checksum を所有するため
import せず維持。サービス用の観測 runtime は logger の初期化を伴うため CLI へ持ち込まず、
明示ログ出力先がある時だけ記録する小さな契約 adapter に限定した。

## 受け入れ条件

C-13 compareMigrations(left, right, ancestor): 同番号で定義が異なり少なくとも片側が祖先にない定義の場合だけ衝突を返す

正常系、同一定義、異番号、既存番号の再利用、静的解析不能、Git 応答不正、CLI 終了コードを
7 ファイルのテストに記述し Augur 台帳へ登録。テスト実行は依頼指定に従い未実施。
型検査は worktree に node_modules がなく実施不能。git diff --check は問題なし。
契約注入 C-13 は成功。注入コマンド全体は既存 orphaned marker 27 件のため exit 1。
Augur 集計の C-13 は calls 0 / met false。実行証跡を成功扱いしない。
