# Concordia — REVIEW_DESIGN (2026-05-13)

評価: **A-**

## 全体所見
README + spec/multi-provider.md + src 構成は一貫しており、 「lock しない調停 (Concordia の語源どおり)」「provider 中立」「個人データ非保管」「loopback 限定」の 4 設計指針を明文化したうえで、 SessionsRepo / Dispatcher / Sweeper / RuleEngine / ProcessManager の責務がきれいに分割されている. spec/multi-provider.md (`spec/multi-provider.md:10`) で `AgentProvider` interface を先に固定し、 claude-code は full / gemini-cli + codex-cli は stub と段階を明示している点は高評価.

## 強い点
- 責務分離が明確 (`src/server.ts:55`): repo 群 + ProcessManager + Dispatcher + Sweeper + RuleEngine + RuleProposer + DailyScheduler が `startBackend()` で組み上がり、 shutdown で逆順停止する pattern が pure (`src/server.ts:201`).
- チャット発火判断を **Concordia 静的アルゴリズム** に固定し、 LLM 判断は AI 側に閉じる方針が `src/dispatcher.ts:1-13` のコメントで明文化されている. これは設計指針「Concordia 自身は LLM を呼ばない」と整合 (例外: rules engine と report generator は claude CLI を呼ぶ — トレードオフは `src/rules/engine.ts:5-8` に明記).
- WebSocket と SSE を併存させ、 SPA は WS / curl + hook は SSE という 2 経路を意図的に維持 (`src/api/ws.ts:1-9`). 過剰一本化を避けた現実的な選択.
- v0.1 (claude-code only) → v0.2 (gemini + codex + worktree 自動化) → v0.3 (Tailscale) の 3 段階 roadmap が README:131-139 に明示.

## 弱い点
- **lost 検知 spec 不整合**: README:53 と spec/multi-provider 系では「5 分」と書かれているが実装は `lostAfterSec=1800` (30 分, `src/shared/config.ts:33`). コメントに「元 5 分は短すぎた」と書いてあり妥当だが、 README が古い数字のままで読者を誤導する.
- **provider 中立を謳いつつ jsonl 復元経路が claude-code 固定**: `spec/multi-provider.md:7-148` の RecoveryInfo は generic だが、 sweeper の `tryRecover()` (`src/sweeper.ts:126`) は `getProvider(name)` 経由で復元するだけで、 gemini/codex stub が `parseTranscript()` で throw するか null を返すかが spec で未定義. Gemini/Codex active 化までに stub の振る舞いを spec 化すべき.
- **rule engine の "1 つだけ走る" 制約** (`src/rules/engine.ts:75-105`) は妥当だが、 `running=true` 中の tick / event を skip するため event-driven rule が "ちょうど busy" のタイミングで取りこぼされる. queue depth=1 程度の最小キューで救済余地あり (設計 trade-off の明示が spec に欠落).
- **per-session report = LLM narrative** が DELETE /v1/sessions/:id の同期パスに組み込まれている (`src/api/sessions.ts:325-330`). 30 秒 claude CLI timeout (`src/rules/claude-runner.ts:15`) が HTTP timeout を直撃する可能性あり. async 化 + status 取得 endpoint の方が運用的に堅い.

## 中長期の懸念
- v0.3 (Tailscale 越え) で loopback 解除されると、 認証なし WS (`src/api/ws.ts:6`) と persona/rule mutation 系 API が tailnet 全体に晒される. Cernere accessToken 検証パスを設計段階で組み込んでおきたい.
- rule_proposer の自走学習 (`src/rules/proposer.ts`) は AI 由来 rule を `maxAiRules` で上限制御するが、 「役に立たない rule が枠を埋めて新規が入らない」状態を解消する pruning ロジックが未設計.
