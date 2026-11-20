import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { readCloudResponse } from "./artifact-transfer.js";
import type { ColabConnection } from "./colab-rest.js";

const MAX_REPORT_BYTES = 32_000;
const PROXY_HEADER = "X-Colab-Runtime-Proxy-Token";
const KernelId = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) });
const FileContents = z.object({ type: z.literal("file"), format: z.enum(["text", "base64"]), content: z.string() });

export interface ColabJupyter {
  execute(connection: ColabConnection, code: string, signal: AbortSignal): Promise<"succeeded" | "failed">;
  readResult(connection: ColabConnection, signal: AbortSignal): Promise<Buffer>;
}

function endpoint(connection: ColabConnection, path: string): URL {
  const url = new URL(connection.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !/(^|\.)(prod\.colab\.dev|colab\.googleusercontent\.com|colab\.research\.google\.com)$/.test(url.hostname)) {
    throw new Error("cloud_colab_connection_invalid");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + path;
  return url;
}

type RunKernel = (url: URL, token: string, code: string, session: string, signal: AbortSignal) => Promise<"succeeded" | "failed">;

const runKernel: RunKernel = (url, token, code, session, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const ws = new WebSocket(url, { headers: { [PROXY_HEADER]: token }, followRedirects: false,
    handshakeTimeout: 15_000, maxPayload: 1_048_576, perMessageDeflate: false });
  const msgId = randomUUID();
  let reply: "succeeded" | "failed" | undefined;
  let idle = false;
  let finished = false;
  function finish(done?: "succeeded" | "failed") {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    if (done) resolve(done);
    else reject(new Error("cloud_colab_execution_unknown"));
    ws.terminate();
  }
  const abort = () => finish();
  signal.addEventListener("abort", abort, { once: true });
  ws.once("error", abort);
  ws.once("close", abort);
  ws.once("open", () => ws.send(JSON.stringify({
    channel: "shell",
    header: { msg_id: msgId, session, msg_type: "execute_request", username: "concordia", version: "5.3", date: new Date().toISOString() },
    parent_header: {}, metadata: {}, buffers: [],
    content: { code, silent: false, store_history: false, user_expressions: {}, allow_stdin: false, stop_on_error: true },
  }), error => { if (error) finish(); }));
  ws.on("message", (data, binary) => {
    if (binary) return;
    try {
      const msg = JSON.parse(data.toString()) as { parent_header?: { msg_id?: string }; header?: { msg_type?: string };
        channel?: string; content?: { status?: string; execution_state?: string } } | null;
      if (msg?.parent_header?.msg_id !== msgId) return;
      if (msg.channel === "shell" && msg.header?.msg_type === "execute_reply") {
        reply = msg.content?.status === "ok" ? "succeeded" : "failed";
      }
      if (msg.channel === "iopub" && msg.header?.msg_type === "status" && msg.content?.execution_state === "idle") idle = true;
      if (reply && idle) finish(reply);
    } catch { finish(); }
  });
});

export class HttpColabJupyter implements ColabJupyter {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly run: RunKernel = runKernel) {}

  private async request(connection: ColabConnection, path: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const result = await this.fetcher(endpoint(connection, path), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error", method: body ? "POST" : "GET",
      headers: { [PROXY_HEADER]: connection.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return JSON.parse((await readCloudResponse(result, 2 * MAX_REPORT_BYTES)).toString("utf8"));
  }

  async execute(connection: ColabConnection, code: string, signal: AbortSignal): Promise<"succeeded" | "failed"> {
    const kernel = KernelId.parse(await this.request(connection, "/api/kernels", signal, { name: "python3" }));
    const session = randomUUID();
    const url = endpoint(connection, `/api/kernels/${kernel.id}/channels`);
    url.protocol = "wss:";
    url.searchParams.set("session_id", session);
    return this.run(url, connection.token, code, session, signal);
  }

  async readResult(connection: ColabConnection, signal: AbortSignal): Promise<Buffer> {
    const result = FileContents.parse(await this.request(connection, "/api/contents/cc-result.json", signal));
    const bytes = Buffer.from(result.content, result.format === "base64" ? "base64" : "utf8");
    if (bytes.length > MAX_REPORT_BYTES) throw new Error("cloud_colab_report_invalid");
    return bytes;
  }
}
