import type { ChatMutationOutboxRepo } from "../db/chat-mutation-outbox-repo.js";

export interface ChatMutationOutboxHandle { stop(): void }

export function installChatMutationOutbox(opts: {
  baseUrl: string;
  repo: ChatMutationOutboxRepo;
  retryMs?: number;
  fetchImpl?: typeof fetch;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}): ChatMutationOutboxHandle {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const nativeFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const previousFetch = globalThis.fetch;
  let stopped = false;

  const wrappedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const isCoreMutation = url.startsWith(`${baseUrl}/`) && !["GET", "HEAD", "OPTIONS"].includes(method);
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      if (!isCoreMutation || stopped) throw error;
      const bodyJson = typeof init?.body === "string" ? init.body : null;
      const path = url.slice(baseUrl.length);
      const id = opts.repo.enqueue({ method, path, bodyJson });
      opts.log?.warn(`core unavailable; queued chat mutation id=${id} ${method} ${path}`);
      return new Response(
        JSON.stringify({ error: "core_unavailable_queued", queued: true, outbox_id: id }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
  };
  globalThis.fetch = wrappedFetch;

  let flushing = false;
  const flush = async (): Promise<void> => {
    if (stopped || flushing) return;
    flushing = true;
    try {
      for (const row of opts.repo.list()) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        try {
          const response = await nativeFetch(`${baseUrl}${row.path}`, {
            method: row.method,
            headers,
            body: row.body_json ?? undefined,
          });
          if (response.ok) {
            opts.repo.remove(row.id);
            opts.log?.info(`replayed chat mutation id=${row.id} ${row.method} ${row.path}`);
          } else if (response.status >= 400 && response.status < 500) {
            opts.repo.remove(row.id);
            opts.log?.warn(`discarded non-retryable chat mutation id=${row.id} status=${response.status}`);
          } else {
            opts.repo.markAttempt(row.id, `HTTP ${response.status}`);
          }
        } catch (error) {
          opts.repo.markAttempt(row.id, error instanceof Error ? error.message : String(error));
          break;
        }
      }
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(() => { void flush(); }, opts.retryMs ?? 3_000);
  timer.unref?.();
  void flush();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = previousFetch;
    },
  };
}
