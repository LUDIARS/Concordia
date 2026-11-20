import { z } from "zod";
import { readCloudResponse } from "./artifact-transfer.js";
import type { AccessTokenSource } from "./google-oauth.js";
import type { ColabBinding } from "./colab-config.js";

const API = "https://colaboratory.googleapis.com";
const RuntimeName = z.string().regex(/^runtimes\/[a-z][a-z0-9-]{0,62}$/);
const OperationName = z.string().regex(/^operations\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).max(250);
const Connection = z.object({ url: z.string().url(), token: z.string().min(1).max(16_384), expireTime: z.string() });
const Runtime = z.object({ name: RuntimeName, connectionInfo: Connection.optional(), runtimeSpec: z.unknown().optional() });
const Operation = z.object({ name: OperationName, done: z.boolean().default(false),
  response: Runtime.optional(), error: z.object({ code: z.number() }).optional() });

export type ColabConnection = z.infer<typeof Connection>;
export type ColabRuntime = z.infer<typeof Runtime>;
export type ColabOperation = z.infer<typeof Operation>;
export interface ColabRest {
  create(name: string, requestId: string, spec: ColabBinding["runtimeSpec"], signal: AbortSignal): Promise<ColabOperation>;
  get(name: string, signal: AbortSignal): Promise<ColabRuntime | null>;
  list(signal: AbortSignal): Promise<string[]>;
  operation(name: string, signal: AbortSignal): Promise<ColabOperation | null>;
  delete(name: string, signal: AbortSignal): Promise<void>;
}

export class ColabRestStatus extends Error {
  constructor(readonly status: number) { super("cloud_colab_provider_error"); }
}

export class GoogleColabRest implements ColabRest {
  constructor(private readonly tokens: AccessTokenSource, private readonly fetcher: typeof fetch = fetch) {}

  private async request(path: string, method: "POST" | "GET" | "DELETE", signal: AbortSignal, body?: object): Promise<unknown> {
    signal.throwIfAborted();
    const token = await this.tokens.accessToken();
    const response = await this.fetcher(API + path, {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ColabRestStatus(response.status);
    }
    if (method === "DELETE") {
      await response.body?.cancel();
      return null;
    }
    return JSON.parse((await readCloudResponse(response, 512_000)).toString("utf8"));
  }

  async create(name: string, requestId: string, spec: ColabBinding["runtimeSpec"], signal: AbortSignal): Promise<ColabOperation> {
    const runtimeId = RuntimeName.parse(name).slice("runtimes/".length);
    const query = new URLSearchParams({ runtimeId, requestId });
    return Operation.parse(await this.request(`/v1beta/runtimes?${query}`, "POST", signal, { runtimeSpec: spec }));
  }

  async get(name: string, signal: AbortSignal): Promise<ColabRuntime | null> {
    try {
      const runtime = Runtime.parse(await this.request(`/v1beta/${RuntimeName.parse(name)}`, "GET", signal));
      if (runtime.name !== name) throw new Error("cloud_colab_runtime_mismatch");
      return runtime;
    } catch (error) {
      if (error instanceof ColabRestStatus && error.status === 404) return null;
      throw error;
    }
  }

  async list(signal: AbortSignal): Promise<string[]> {
    const response = await this.request("/v1beta/runtimes", "GET", signal);
    return z.object({ runtimes: z.array(Runtime).default([]) }).parse(response).runtimes.map(runtime => runtime.name);
  }

  async operation(name: string, signal: AbortSignal): Promise<ColabOperation | null> {
    try {
      const operation = Operation.parse(await this.request(`/v1/${OperationName.parse(name)}`, "GET", signal));
      if (operation.name !== name) throw new Error("cloud_colab_runtime_mismatch");
      return operation;
    } catch (error) {
      if (error instanceof ColabRestStatus && error.status === 404) return null;
      throw error;
    }
  }

  async delete(name: string, signal: AbortSignal): Promise<void> {
    await this.request(`/v1beta/${RuntimeName.parse(name)}?allowMissing=true`, "DELETE", signal);
  }
}
