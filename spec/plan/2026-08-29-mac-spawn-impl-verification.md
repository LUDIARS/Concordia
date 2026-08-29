# Mac Terminal spawn + template overrides — 検証記録

実施日: 2026-08-29

- `npm run typecheck`: original author 実装時は pass。共有依存の `tsc` を PATH に解決して実行し、production/test の両 tsconfig を完走した。Revisor autofix 後は実行権限制約により未再実行。
- `npx vitest run src/control/spawner.test.ts src/delegation/template-overrides.test.ts src/federation/config-snapshot.test.ts src/federation/protocol.test.ts`: original author 実装時は pass。共有 `node_modules` junction 配下へ Vite の config bundle 一時ファイルを書けないため、等価な `--configLoader runner` を付けて実行した。Revisor autofix で回帰ケースを追加した後は実行権限制約により未再実行。
- `grep -n "CONCORDIA_MAC_SPAWN" src/control/spawner.ts spec/setup/spawn.md`: pass（双方でヒット）。
- `grep -rn "delegation_template_overrides" src/db src/api src/delegation src/federation`: pass（schema / repo / resolver / federation snapshot にヒット）。
- `git diff main --stat`: pass。`package.json` / `package-lock.json` は差分に含まれない。
- `git diff main | Anatomia verify --project concordia --json`: 実行済み。rule conformance / duplication / coupling delta / convention drift は pass。`concordia` 登録プロジェクトが linked worktree ではなく親 checkout を参照するため、worktree 上で追加した `SPEC-DELEGATION-TEMPLATE-OVERRIDES` のリンクを読めず spec_linkage が fail となる。ソースと仕様には同 requirement ID の `@implements` を追加済みであり、登録先が当該 worktree を解析する環境で再実行が必要。
