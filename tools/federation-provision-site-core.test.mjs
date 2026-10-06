import { describe, expect, it } from "vitest";
import {
  buildSiteOperation,
  excubitorPortFromCatalog,
  hqUrlFromListener,
  isFinalStatus,
  isPlainWsHost,
  parseProvisionArgs,
  siteConnection,
  validateHqUrl,
} from "./federation-provision-site-core.mjs";

describe("federation-provision-site core", () => {
  it("parses the required arguments", () => {
    expect(parseProvisionArgs(["--peer", "p1", "--site-id", "melpot", "--name", "MELPOT"]).value)
      .toEqual({ peer: "p1", siteId: "melpot", name: "MELPOT", hqUrl: null, dryRun: false });
    expect(parseProvisionArgs(["--site-id", "melpot"]).error).toMatch(/--peer/);
    expect(parseProvisionArgs(["--peer", "p1", "--site-id", "Bad_ID"]).error).toMatch(/--site-id/);
    expect(parseProvisionArgs(["--peer", "p1", "--site-id", "melpot", "--bogus"]).error).toMatch(/unknown/);
  });

  it("uses the same plain-ws rule as the site client (CC-FED-T1)", () => {
    expect(isPlainWsHost("100.122.174.105")).toBe(true);
    expect(isPlainWsHost("100.64.0.1")).toBe(true);
    expect(isPlainWsHost("100.128.0.1")).toBe(false);
    expect(isPlainWsHost("192.168.0.2")).toBe(false);
    expect(isPlainWsHost("[fd7a:115c:a1e0::1]")).toBe(true);
  });

  it("builds the HQ URL from the running listener bind", () => {
    expect(hqUrlFromListener({ enabled: true, running: { host: "100.122.174.105", port: 11112 } }).value)
      .toBe("ws://100.122.174.105:11112/federation/ws");
    expect(hqUrlFromListener({ enabled: false, running: null }).error).toMatch(/listener/);
    expect(hqUrlFromListener({ enabled: true, running: { host: "127.0.0.1", port: 11112 } }).error).toMatch(/loopback/);
    expect(hqUrlFromListener({ enabled: true, running: { host: "0.0.0.0", port: 11112 } }).error).toMatch(/tailnet/);
  });

  it("validates an explicit HQ URL", () => {
    expect(validateHqUrl("ws://100.122.174.105:11112").value).toBe("ws://100.122.174.105:11112/federation/ws");
    expect(validateHqUrl("wss://hq.example.com/federation/ws").value).toBe("wss://hq.example.com/federation/ws");
    expect(validateHqUrl("ws://hq.example.com:11112").error).toMatch(/wss/);
    expect(validateHqUrl("http://100.1.1.1").error).toMatch(/ws:\/\//);
  });

  it("reads the excubitor port from the catalog text", () => {
    const catalog = [
      "services:",
      "  - code: excubitor-viewer-dmz",
      "    port: 17334",
      "  - code: excubitor",
      "    name: Excubitor",
      "    port: 17332",
      "    ports:",
      "      - role: federation",
      "        port: 17335",
    ].join("\r\n");
    expect(excubitorPortFromCatalog(catalog)).toBe(17332);
    expect(excubitorPortFromCatalog("services: []")).toBeNull();
  });

  it("builds the operation body expected by Excubitor", () => {
    expect(buildSiteOperation({ hqUrl: "ws://100.1.1.1:1/federation/ws", siteId: "melpot", token: "t" })).toEqual({
      target: { kind: "service", code: "concordia" },
      action: "concordia-federation-site",
      federation_site: { hq_url: "ws://100.1.1.1:1/federation/ws", site_id: "melpot", token: "t" },
    });
  });

  it("reads operation and connection status", () => {
    expect(isFinalStatus("succeeded")).toBe(true);
    expect(isFinalStatus("queued")).toBe(false);
    expect(siteConnection({ sites: [{ site_id: "melpot", status: "active", connection: "online" }] }, "melpot"))
      .toEqual({ status: "active", connection: "online", site_version: null });
    expect(siteConnection({ sites: [] }, "melpot")).toBeNull();
  });
});
