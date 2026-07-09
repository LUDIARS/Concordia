import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { probeProjectSufficiency } from "./data-sufficiency.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer<T>(handler: Handler, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("server address unavailable"));
      else resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  try {
    return await fn(baseUrl);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

describe("probeProjectSufficiency", () => {
  it("reads Anatomia and Thaleia summaries using the project leaf", async () => {
    const seen: string[] = [];
    await withServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "/api/projects/lictor/summary") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ files: 3, functions: 12, nodes: 20, edges: 4, domains: 2, links: 5 }));
        return;
      }
      if (req.url === "/reconcile?project=lictor") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          generatedAt: "2026-07-10T00:00:00.000Z",
          summary: { specs: 7, implementedSpecs: 4 },
          gaps: [{ id: "a" }, { id: "b" }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (baseUrl) => {
      const result = await probeProjectSufficiency("E:\\Document\\Ars\\Lictor", {
        anatomiaBaseUrl: baseUrl,
        thaleiaBaseUrl: baseUrl,
        timeoutMs: 1000,
      });
      expect(result).toEqual({
        project: "lictor",
        anatomia: { present: true, functions: 12, domains: 2, links: 5 },
        thaleia: {
          present: true,
          generatedAt: "2026-07-10T00:00:00.000Z",
          specs: 7,
          implementedSpecs: 4,
          gapCount: 2,
        },
      });
      expect(seen).toContain("/api/projects/lictor/summary");
      expect(seen).toContain("/reconcile?project=lictor");
    });
  });

  it("returns absent summaries for 404 responses", async () => {
    await withServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    }, async (baseUrl) => {
      await expect(probeProjectSufficiency("Concordia", {
        anatomiaBaseUrl: baseUrl,
        thaleiaBaseUrl: baseUrl,
        timeoutMs: 1000,
      })).resolves.toEqual({
        project: "concordia",
        anatomia: { present: false },
        thaleia: { present: false },
      });
    });
  });

  it("fails open on timeout", async () => {
    await withServer((_req, _res) => {}, async (baseUrl) => {
      await expect(probeProjectSufficiency("SlowProject", {
        anatomiaBaseUrl: baseUrl,
        thaleiaBaseUrl: baseUrl,
        timeoutMs: 20,
      })).resolves.toEqual({
        project: "slowproject",
        anatomia: { present: false },
        thaleia: { present: false },
      });
    });
  });
});
