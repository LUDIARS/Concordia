/**
 * カリオペの use case (契約 v1 §4c `calliope.product` / `calliope.refresh`)。
 *
 * - product: 保存済みの文書を返す。 未生成なら not_found。
 * - refresh: 非同期で作り直す。 同一プロジェクトは 1 時間に 1 回まで (保存済みの生成時刻も数える)。
 *   完了したら `event: calliope.updated` を全接続へ流す。 LLM 生成物は常に draft:true。
 *
 * @implements spec/feature/glab-unity-hub.md §4c (GUH-CALLIOPE)
 */

import { HubError } from "../domain/protocol.js";
import { HUB_LIMITS, KeyedThrottle } from "../domain/rate-limit.js";
import { buildCalliopePrompt, parseCalliopeOutput, toCalliopeProduct, type CalliopeProduct } from "../domain/calliope-product.js";
import type { HubPayload } from "../domain/methods.js";
import type { CalliopeMaterialsPort, CalliopeStore, CalliopeWriterPort, Clock } from "./ports.js";
import type { MethodContext } from "./method-context.js";

export interface CalliopeServiceDeps {
  readonly store: CalliopeStore;
  readonly materials: CalliopeMaterialsPort;
  readonly writer: CalliopeWriterPort;
  readonly clock: Clock;
  readonly projects: readonly string[];
  /** 完了・失敗の通知 (event: calliope.updated)。 */
  readonly broadcast: (event: string, data: unknown) => void;
  readonly log?: (message: string) => void;
}

export class HubCalliopeService {
  private readonly throttle = new KeyedThrottle(HUB_LIMITS.calliopeRefreshWindowMs);
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: CalliopeServiceDeps) {}

  async product(_context: MethodContext, payload: HubPayload<"calliope.product">): Promise<CalliopeProduct> {
    this.requireProject(payload.project);
    const product = this.deps.store.load(payload.project);
    if (!product) throw new HubError("not_found", "calliope document has not been generated yet; call calliope.refresh");
    return product;
  }

  async refresh(_context: MethodContext, payload: HubPayload<"calliope.refresh">): Promise<{ accepted: boolean; nextAllowedAt: string }> {
    this.requireProject(payload.project);
    const now = this.deps.clock.now().getTime();
    const saved = this.deps.store.load(payload.project);
    if (saved) {
      const at = Date.parse(saved.generatedAt);
      if (Number.isFinite(at)) this.throttle.seed(payload.project, at);
    }
    if (this.running.has(payload.project) || !this.throttle.tryPass(payload.project, now)) {
      throw new HubError("rate_limited",
        `calliope.refresh is limited to once per hour (next: ${new Date(this.throttle.nextAllowedAt(payload.project, now)).toISOString()})`);
    }
    const job = this.generate(payload.project).finally(() => this.running.delete(payload.project));
    this.running.set(payload.project, job);
    return { accepted: true, nextAllowedAt: new Date(this.throttle.nextAllowedAt(payload.project, now)).toISOString() };
  }

  /** テストと停止処理が完了を待つため。 */
  pending(project: string): Promise<void> | undefined {
    return this.running.get(project);
  }

  private async generate(project: string): Promise<void> {
    try {
      const materials = await this.deps.materials.collect(project);
      if (materials.length === 0) throw new Error("no materials");
      const raw = await this.deps.writer.write(buildCalliopePrompt(project, materials));
      const generated = raw === null ? null : parseCalliopeOutput(raw);
      if (!generated) throw new Error("calliope output did not match the contract");
      const product = toCalliopeProduct({ project, generated, materials, generatedAt: this.deps.clock.now().toISOString() });
      this.deps.store.save(product);
      this.deps.broadcast("calliope.updated", { project, generatedAt: product.generatedAt, ok: true });
    } catch (error) {
      this.deps.log?.(`calliope refresh failed project=${project}: ${error instanceof Error ? error.message : String(error)}`);
      this.deps.broadcast("calliope.updated", { project, ok: false });
    }
  }

  private requireProject(project: string): void {
    if (!this.deps.projects.includes(project)) throw new HubError("not_found", "project is not configured for GLab-UnityHub");
  }
}
