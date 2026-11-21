import { describe, expect, it, vi } from "vitest";
import { colabSiteTransport } from "./colab-site-excubitor.js";
import type { SiteSubmit } from "./colab-site-schema.js";

const payload: SiteSubmit = { idempotencyKey: "same-id", ownerId: "owner", ownerStart: true, programId: "checks",
  sourceRevision: "a".repeat(40), programSha256: "b".repeat(64), gpu: "T4", deadlineAt: 1_800_000_000_000,
  code: "public", data: "non_confidential" };

function transport(response: () => Response) {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/services/excubitor") return Response.json({ code: "excubitor", port: 14100 });
    if (url.pathname === "/health") return Response.json({ service: "excubitor" });
    return response();
  });
  return { ex: colabSiteTransport({ CONCORDIA_EXCUBITOR_URL: "http://127.0.0.1:14000" }, fetcher), fetcher };
}

describe("Excubitor Colab HTTP boundary", () => {
  it("checks the catalog and listener identity before a read-only peer readiness probe", async () => {
    const { ex, fetcher } = transport(() => Response.json({ error: "colab_job_missing" }, { status: 404 }));
    await expect(ex.readiness("gromac")).resolves.toBeNull();
    const calls = fetcher.mock.calls.map(([url, options]) => [String(url), options?.method ?? "GET"]);
    expect(calls).toEqual([
      ["http://127.0.0.1:14000/api/v1/services/excubitor", "GET"],
      ["http://127.0.0.1:14100/health", "GET"],
      [expect.stringMatching(/^http:\/\/127\.0\.0\.1:14100\/api\/v1\/colab\/peers\/gromac\/jobs\/[0-9a-f-]{36}$/), "GET"],
    ]);
  });

  it("surfaces explicit mesh configuration failures and treats an unverified submit response as ambiguous", async () => {
    const mesh = transport(() => Response.json({ error: "mesh_security_not_configured" }, { status: 502 }));
    await expect(mesh.ex.readiness("gromac")).resolves.toBe("cloud_colab_site_mesh_not_ready");
    const lost = transport(() => Response.json({ error: "colab_site_response_unverified" }, { status: 502 }));
    await expect(lost.ex.submit("gromac", payload)).rejects.toThrow("cloud_colab_site_submission_unknown");
    expect(lost.fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    const [url, options] = lost.fetcher.mock.calls.at(-1)!;
    expect(String(url)).toBe("http://127.0.0.1:14100/api/v1/colab/peers/gromac/jobs");
    expect(JSON.parse(String(options?.body))).toEqual(payload);
  });
});
