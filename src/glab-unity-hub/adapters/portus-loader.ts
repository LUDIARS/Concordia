/**
 * Portus (`@ludiars/portus`) を実行時に読み込む (契約 v1 §2: HTTP/WS は Portus、 Hono 禁止)。
 *
 * Portus は LUDIARS の Node サーバ基盤 (実行時依存ゼロ)。 依存として取り込むには外部取り込みの
 * 検査記録が要るため、 この変更では package.json に足さず、 起動時に次の順で探す:
 *   1. パッケージ `@ludiars/portus` (取り込み後)
 *   2. env `GLAB_UNITY_HUB_PORTUS_ROOT` が指すビルド済み Portus (`<root>/dist/http/index.js`)
 * どちらも無ければ理由付きで起動を止める (黙って別の WS 実装へ落とさない)。
 *
 * 型は使う範囲だけをここで宣言する (Portus の公開 API: http.createHttpServer / ws.WebSocket)。
 *
 * @implements spec/feature/glab-unity-hub.md §5 (GUH-PORTUS)
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface PortusRequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly query: Record<string, unknown>;
}

export interface PortusReplyLike {
  readonly status: number;
}

export interface PortusRouteDef {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly handler: (ctx: PortusRequestContext) => unknown | Promise<unknown>;
  readonly note?: string;
}

export interface PortusHttpServerLike {
  readonly server: Server;
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

export interface PortusWebSocketLike {
  readyState: number;
  attach(socket: Duplex, head?: Buffer): void;
  send(data: string | Buffer): void;
  ping(data?: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface PortusModules {
  readonly createHttpServer: (options: { routes: PortusRouteDef[]; maxBodyBytes?: number }) => PortusHttpServerLike;
  readonly json: (value: unknown, status?: number) => PortusReplyLike;
  readonly WebSocket: new (isClient: boolean, maxPayload?: number) => PortusWebSocketLike;
}

type Importer = (specifier: string) => Promise<Record<string, unknown>>;

/** 動的 import を差し替え可能にする (テストと、 型解決を build 時に要求しないため)。 */
const defaultImporter: Importer = (specifier) => import(specifier) as Promise<Record<string, unknown>>;

function pick(http: Record<string, unknown>, ws: Record<string, unknown>): PortusModules | null {
  const { createHttpServer, json } = http;
  const { WebSocket } = ws;
  if (typeof createHttpServer !== "function" || typeof json !== "function" || typeof WebSocket !== "function") return null;
  return { createHttpServer, json, WebSocket } as unknown as PortusModules;
}

export async function loadPortus(env: NodeJS.ProcessEnv = process.env, importer: Importer = defaultImporter): Promise<PortusModules> {
  const tried: string[] = [];
  const candidates: Array<[string, string]> = [["@ludiars/portus/http", "@ludiars/portus/ws"]];
  const root = (env.GLAB_UNITY_HUB_PORTUS_ROOT ?? "").trim();
  if (root) {
    candidates.push([
      pathToFileURL(join(root, "dist", "http", "index.js")).href,
      pathToFileURL(join(root, "dist", "ws", "index.js")).href,
    ]);
  }
  for (const [httpSpec, wsSpec] of candidates) {
    try {
      const modules = pick(await importer(httpSpec), await importer(wsSpec));
      if (modules) return modules;
      tried.push(`${httpSpec} (unexpected exports)`);
    } catch {
      tried.push(httpSpec);
    }
  }
  throw new Error(
    "Portus is not available. Install @ludiars/portus or set GLAB_UNITY_HUB_PORTUS_ROOT to a built Portus checkout"
    + ` (tried: ${tried.join(", ")})`,
  );
}
