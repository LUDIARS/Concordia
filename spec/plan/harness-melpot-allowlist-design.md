# 設計書: ハーネス main push 許可リスト (MELPOT 例外)

- 作成: 2026-08-12
- 運用要件 (2026-08-12): MELPOT は push を閉じておらず全リポジトリが private のため、
  ハーネスの `no-main-push` ルールに MELPOT 例外を追加する。

## 1. 仕様

### 1.1 許可リスト設定

- Cc 設定 (既存の設定機構に合わせる。env fallback 可):
  `HARNESS_MAIN_PUSH_ALLOWLIST` — カンマ区切りで「リポジトリのディレクトリ名
  または絶対パス」。既定値 (シード): `KuzuSurvivors,MakaiNui` (= 現行 MELPOT ローカル
  クローン)。設定の読み出し方は Cc の既存 config パターン (他の HARNESS_* / CONCORDIA_*
  がどう読まれているか) に合わせること。
- 判定は blackbox-engine の特徴量に追加:
  `main_push_allowlisted` = `command_pushes_main` が true かつ、`action.cwd` の
  パス (正規化・小文字比較) が許可リストのいずれかに一致 (絶対パス一致 or
  パス区切り単位でディレクトリ名一致)。`action.command` 内の `git -C <path>` の
  path も cwd と同様に判定対象にする (例: `git -C C:/repos/KuzuSurvivors push origin main`)。

### 1.2 ルール変更

- SEEDED_GATE_RULES の `no-main-push` ルールの `when` を
  `and(eq("command_pushes_main", true), eq("main_push_allowlisted", false))` へ変更。
- deny 文言は現状維持 + 「(許可リスト: HARNESS_MAIN_PUSH_ALLOWLIST)」を suggestion に追記。
- **シードの更新反映**: 既存 DB に旧ルールが seed 済みの場合の再シード/upsert の
  仕組みを調査し、Cc 再起動で新 `when` が確実に効く形にする (seed が insert-once なら
  同 source/rule キーの upsert を実装。挙動を README かコード内コメントに明記)。

### 1.3 スコープ外 / 不変

- 他のシードルール (branch-before-edit 等) は不変。
- 許可リスト該当時も **警告は出してよい** (info/warn で「allowlisted main push」を
  audit ログへ残す) — 黙って素通しにせず追跡可能にする。
- ローカルフック (`.claude/hooks/harness-gate.mjs`) 側の変更は不要のはず
  (verdict は Cc 側で決まる)。必要になった場合のみ最小変更し、理由を報告。

## 2. テスト

Cc の既存テスト流儀 (`src/harness/*.test.ts` / vitest) に合わせて:

1. `git -C C:/repos/KuzuSurvivors push origin main` + allowlist 既定 →
   verdict allow (または warn) で deny されない。audit に allowlisted 記録。
2. 同コマンドで allowlist を空に → 従来どおり deny。
3. `git push origin main` を cwd=KuzuSurvivors 配下で → allow。cwd=Figmentum → deny。
4. 許可リストのパス一致が大文字小文字/スラッシュ向きに頑健 (Windows パス)。
5. 既存の no-main-push テスト (非許可リポ) が全て従来判定のまま green。
6. シード upsert: 旧ルールが入った状態から再シード → 新 when が有効。
7. 複合コマンドに許可リポの decoy `git -C` を混ぜても、非許可リポへの push は deny。
8. `..` による許可パス外への traversal と、inline alias / 追加 Git global option で
   push 対象を曖昧にするコマンドは deny。
9. 大文字小文字違い、完全修飾 ref、`--all` / `--mirror` でも main push 判定が述語と
   blackbox で一致する。

注意: vitest は registry 共有で vi.mock が効かない環境 (isolate:false)。モックより
注入で書く (既存テストの流儀を踏襲)。

## 3. 完了条件

- 対象テスト green (実行したテストファイルと pass/fail 数を報告)。
- 変更ファイル一覧・コミット SHA。
- デプロイ手順の確認メモ (build → Excubitor 再起動が必要か、seed 反映の手順) を
  最終報告に含める (デプロイ自体は設計側が cc-deploy フローで行う)。
