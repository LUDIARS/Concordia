# ハーネス状態カード (フック3) — 実装スペック (Codex 委託用)

対象リポ: `E:/Document/Ars/Concordia` (単一リポ完結)。design=Claude / impl=Codex。
このスペック通りに実装し、末尾のチェックリスト結果を PR 説明に貼ること。

## 目的

セッションの状態カード (Web ダッシュボード + Discord embed) に次を表示する:

1. **作業対象プロジェクト** (`target_project`)
2. **現在ブランチ** (`branch` — 既に一部表示済)
3. **Anatomia データ充足** (解析の有無・規模)
4. **Thaleia データ充足** (reconcile snapshot の有無・カバレッジ)

既存インフラを最大限再利用し、**新規サービスや重複クライアントを作らない**。Anatomia/Thaleia
照会は既存の読み取りパターン (`src/harness/prompt-research.ts` / `src/anatomia/cache-stats-client.ts`)
を踏襲する (fail-open・短 timeout・env でベース URL 差し替え)。

## 前提 (既存コード — 変更前に必ず読む)

- `src/shared/types.ts` `SessionRow` — `target_project: string | null` と `branch` は**既にある**。
- `src/api/sessions/shared.ts` `serializeSession()` — **`target_project` を返していない** (追加が必要)。
- `web/src/api.ts` `SessionRow` (web 型) — `target_project` が無い (追加が必要)。
- `web/src/pages/Monitor.tsx` — `ActiveSessionRows` / `SessionCard` がカード描画。`branch` は描画済。
- `src/discord/session-status-card.ts` `buildSessionStatusEmbed()` — Branch 欄・「Anatomia キャッシュ」欄が既にある。
- `src/harness/prompt-research.ts` — `researchAnatomiaProject()` (`GET {ANATOMIA}/api/graph?project=`) と
  `researchThaleiaProject()` (`GET {THALEIA}/api/links/worklist?project=`) の**照会実装が既にある**。充足判定の参考。
- Anatomia HTTP: `GET /api/projects/:id/summary` → `{files,functions,nodes,edges,domains,links}` (404=未解析)。
  既定 `http://127.0.0.1:4200`、env `ANATOMIA_BASE_URL`。
- Thaleia HTTP: `GET /reconcile?project=<label>` → snapshot (404=未生成)、`generatedAt` + `summary.{specs,implementedSpecs}` + gaps。
  既定 `http://127.0.0.1:8890`、env `THALEIA_BASE_URL`。

## 実装タスク

### T1. `target_project` をシリアライズ (最小・必須)
- `src/api/sessions/shared.ts` `serializeSession()` の返却に `target_project: row.target_project ?? null` を追加。
- `web/src/api.ts` の web 側 `SessionRow` 型に `target_project?: string | null` を追加。

### T2. データ充足プローブ (新規 1 モジュール)
- 新規 `src/harness/data-sufficiency.ts` を作る。純関数 + 薄い HTTP 読み取り。
  ```ts
  export interface ProjectSufficiency {
    project: string;
    anatomia: { present: boolean; functions?: number; domains?: number; links?: number };
    thaleia: { present: boolean; generatedAt?: string; specs?: number; implementedSpecs?: number; gapCount?: number };
  }
  export async function probeProjectSufficiency(project: string, opts?: {...}): Promise<ProjectSufficiency>
  ```
- Anatomia: `GET {ANATOMIA_BASE_URL}/api/projects/<leaf(project)>/summary`。200→present:true + counts、404/エラー→present:false。
- Thaleia: `GET {THALEIA_BASE_URL}/reconcile?project=<leaf(project)>`。200→present:true + fields、404/エラー→present:false。
- `node:http` (agent:false) + `AbortController` で **1500ms timeout**、**fail-open** (落ちても present:false を返し例外を投げない)。
  `prompt-research.ts` / `cache-stats-client.ts` と同じ流儀。ベース URL は env、既定 4200/8890。
- `project` はパス/名前どちらでも受け、`leaf` (末尾要素) を projectId として使う (`src/harness/predicates.ts` の `repoLeaf` を import 再利用)。

### T3. `/v1/monitor` に充足を載せる
- `src/api/monitor.ts` の active セッション enrich (現状 `last_user_message` を足している箇所) で、
  `target_project ?? repo_path` の leaf をキーに `probeProjectSufficiency` を呼び、結果を各セッションに `sufficiency` として付与。
  **N+1 を避ける**: 同一 project は 1 回だけ照会 (Map キャッシュ)、全体でも並列 `Promise.all`。プローブ失敗は握って続行。
- 型: `web/src/api.ts` の monitor 応答型にも `sufficiency?: ProjectSufficiency` を追加。

### T4. Web カード描画
- `web/src/pages/Monitor.tsx` の `ActiveSessionRows` と `SessionCard` に、
  - `target_project` (あれば) を 1 行、
  - Anatomia 充足バッジ (present: `An ✓ fn=<functions> dom=<domains>` / absent: `An —`)、
  - Thaleia 充足バッジ (present: `Th ✓ <implementedSpecs>/<specs> gap=<gapCount>` / absent: `Th —`)
  を追加。既存 Tailwind クラスに合わせ、`branch` 表示の近くに置く。**スタブ (`<div/>` だけ) にしない**。

### T5. Discord embed
- `src/discord/session-status-card.ts` `buildSessionStatusEmbed()` に「作業対象」欄 (target_project) と
  「Anatomia/Thaleia 充足」欄を追加。既存「Anatomia キャッシュ」欄の隣。snapshot 元 (`chat-read-model.ts`
  `getSessionStatusSnapshot`) に充足フィールドを通す必要があれば最小限で足す。

### T6. テスト (vitest)
- `src/harness/data-sufficiency.test.ts`: `probeProjectSufficiency` を、HTTP を stub (`vi.fn`/ローカル http server) して
  present/absent/timeout の 3 系統で検証。leaf 変換 (`E:\...\Lictor` → `lictor`) も。
- `serializeSession` が `target_project` を返すことの回帰テスト (既存 session serialize テストに 1 ケース追加)。

## 禁止事項 (anti-stub)
- 既存の `serializeSession` / `Monitor.tsx` / `session-status-card.ts` を**リネームや別実装で置換しない**。既存に**追記**する。
- Anatomia/Thaleia の照会を**新しい重複クライアントで作らない** — 既存流儀 (env base URL + node:http + fail-open) を踏襲。
- ハードコード port を撒かない (env + 既定値の 1 箇所)。

## 完了チェックリスト (PR 説明に結果を貼る — grep で機械判定)
1. `grep -n "target_project" src/api/sessions/shared.ts` → serializeSession が返している。
2. `grep -n "target_project" web/src/api.ts` → web 型にある。
3. `test -f src/harness/data-sufficiency.ts && grep -c "probeProjectSufficiency" src/harness/data-sufficiency.ts` → 1 以上。
4. `grep -n "sufficiency" src/api/monitor.ts web/src/api.ts` → monitor が付与、web 型にある。
5. `grep -nE "An |Anatomia|Thaleia|Th " web/src/pages/Monitor.tsx` → カードに充足表示が描画コードとして存在 (JSX、スタブでない)。
6. `grep -n "outsideScope\|target" src/discord/session-status-card.ts` → 作業対象/充足欄が追加されている。
7. `npx vitest run src/harness/data-sufficiency.test.ts` → pass。
8. `npm run lint` (tsc --noEmit) → 追加分に型エラー無し。
9. `cd web && npm run build` → web ビルド成功 (React カード描画が実体)。

## 参考: フック2 (already merged 予定 PR #295)
`src/harness/predicates.ts` に `outsideScope` 述語 + `repoLeaf` が入る。`repoLeaf` は本タスクでも再利用する。
