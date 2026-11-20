import type { CloudReceipt } from "./submission.js";
import { releaseEvidence } from "./colab-policy.js";
import type { CloudExecutionAdapter, ExecutionIdentity, ResourceRelease } from "./execution-adapter.js";
import { ColabRestStatus, type ColabConnection, type ColabRest } from "./colab-rest.js";
import type { ColabBinding } from "./colab-config.js";
import type { ColabJupyter } from "./colab-jupyter.js";
import { parseColabResult, type ColabReport } from "./colab-result.js";

export interface ColabAllocation {
  name: string;
  requestId: string;
  runtimeSpec: ColabBinding["runtimeSpec"];
}

export class ColabAllocationRefused extends Error {
  constructor() { super("cloud_colab_allocation_refused"); }
}

export class ColabAdapter implements CloudExecutionAdapter<ColabAllocation, ColabReport> {
  readonly provider = "colab";
  constructor(private readonly rest: ColabRest, private readonly jupyter: ColabJupyter, private readonly run: {
    allocation: ColabAllocation; attemptId: string; revision: string; checkpoints: readonly string[];
  }, private readonly signal: AbortSignal, private readonly now: () => number = Date.now) {}

  async submit(request: ColabAllocation, save: (receipt: CloudReceipt) => Promise<void>): Promise<CloudReceipt> {
    let operation;
    try {
      operation = await this.rest.create(request.name, request.requestId, request.runtimeSpec, this.signal);
    } catch (error) {
      if (error instanceof ColabRestStatus && [400, 401, 403, 429].includes(error.status)) throw new ColabAllocationRefused();
      return { state: "submission_unknown", requestId: request.requestId };
    }
    const pending: CloudReceipt = { state: "submission_unknown", requestId: request.requestId, operationId: operation.name };
    await save(pending);
    if (!operation.done) return pending;
    if (operation.error) throw new ColabAllocationRefused();
    if (operation.response?.name !== request.name) throw new Error("cloud_colab_runtime_mismatch");
    return { ...pending, state: "submitted", remoteId: request.name };
  }

  async reconcile(identity: ExecutionIdentity): Promise<CloudReceipt> {
    const { receipt } = identity, { name } = this.run.allocation;
    if (receipt.state === "submitted") return receipt;
    if (receipt.operationId) {
      const operation = await this.rest.operation(receipt.operationId, this.signal);
      if (operation?.done && operation.error) throw new ColabAllocationRefused();
      if (operation?.done && operation.response?.name !== name) throw new Error("cloud_colab_runtime_mismatch");
      if (operation?.done) return { ...receipt, state: "submitted", remoteId: name };
    }
    const runtime = await this.rest.get(name, this.signal);
    if (runtime) return { ...receipt, state: "submitted", remoteId: name };
    return receipt;
  }

  async observe(identity: ExecutionIdentity): Promise<"unknown" | "running"> {
    if (identity.receipt.state !== "submitted") return "unknown";
    const runtime = await this.rest.get(this.run.allocation.name, this.signal);
    return runtime ? "running" : "unknown";
  }

  async execute(code: string): Promise<"succeeded" | "failed"> {
    return this.jupyter.execute(await this.connection(), code, this.signal);
  }

  async collect(): Promise<ColabReport> {
    const bytes = await this.jupyter.readResult(await this.connection(), this.signal);
    return parseColabResult(bytes, this.run.attemptId, this.run.revision, this.run.checkpoints);
  }

  // Colab has no separate job cancellation endpoint. The caller records the request
  // and confirms cancellation via release of this dedicated runtime.
  async cancel(): Promise<"requested"> {
    await this.rest.delete(this.run.allocation.name, this.signal);
    return "requested";
  }

  async release(identity: ExecutionIdentity, refused = false): Promise<ResourceRelease> {
    const { name } = this.run.allocation;
    let resolved = refused || identity.receipt.state === "submitted";
    const runtime = await this.rest.get(name, this.signal);
    if (runtime || identity.receipt.state === "submitted") {
      resolved = true;
      await this.cancel();
    }
    return releaseEvidence(resolved, !await this.rest.get(name, this.signal));
  }

  private async connection(): Promise<ColabConnection> {
    // A second get can refresh short-lived proxy credentials. Do not replay execution on socket loss.
    for (let read = 0; read < 2; read++) {
      const runtime = await this.rest.get(this.run.allocation.name, this.signal);
      if (runtime) {
        const spec = runtime.runtimeSpec as Partial<ColabBinding["runtimeSpec"]> | undefined;
        const expected = this.run.allocation.runtimeSpec;
        if (spec?.variant !== expected.variant || spec.accelerator !== expected.accelerator || spec.shape !== expected.shape) {
          throw new Error("cloud_colab_runtime_mismatch");
        }
      }
      const connection = runtime?.connectionInfo;
      if (connection && Date.parse(connection.expireTime) > this.now() + 15_000) return connection;
    }
    throw new Error("cloud_colab_connection_invalid");
  }
}
