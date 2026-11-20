import { describe, expect, it, vi } from "vitest";
import { GoogleColabRest } from "./colab-rest.js";
import { HttpColabJupyter } from "./colab-jupyter.js";

describe("Colab transports", () => {
  it("uses the pinned runtime name and UUID on create, then reads operation and runtime and deletes that name", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: "operations/op-1" }))
      .mockResolvedValueOnce(Response.json({ name: "operations/op-1", done: true, response: { name: "runtimes/cc-1" } }))
      .mockResolvedValueOnce(Response.json({ runtimes: [{ name: "runtimes/cc-1" }] }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = new GoogleColabRest({ accessToken: async () => "test-only-oauth" }, fetcher);
    const signal = new AbortController().signal;
    const id = "cfa5a73e-eb5c-46e4-b98b-67442e6515a3";
    const spec = { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } as const;
    expect(await client.create("runtimes/cc-1", id, spec, signal)).toMatchObject({ name: "operations/op-1", done: false });
    expect((await client.operation("operations/op-1", signal))?.response?.name).toBe("runtimes/cc-1");
    expect(await client.list(signal)).toEqual(["runtimes/cc-1"]);
    await client.delete("runtimes/cc-1", signal);
    expect(await client.get("runtimes/cc-1", signal)).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `https://colaboratory.googleapis.com/v1beta/runtimes?runtimeId=cc-1&requestId=${id}`,
      "https://colaboratory.googleapis.com/v1/operations/op-1", "https://colaboratory.googleapis.com/v1beta/runtimes",
      "https://colaboratory.googleapis.com/v1beta/runtimes/cc-1?allowMissing=true",
      "https://colaboratory.googleapis.com/v1beta/runtimes/cc-1",
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify({ runtimeSpec: spec }), redirect: "error" });
  });

  it("sends only the proxy credential to the Google Jupyter URL and reads a bounded result", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "kernel-1" }))
      .mockResolvedValueOnce(Response.json({ type: "file", format: "text", content: "{}" }));
    const run = vi.fn(async () => "succeeded" as const);
    const client = new HttpColabJupyter(fetcher, run);
    const signal = new AbortController().signal;
    const connection = { url: "https://fixture.prod.colab.dev/scope", token: "test-only-proxy", expireTime: "2099-01-01T00:00:00Z" };
    await expect(client.execute(connection, "print(1)", signal)).resolves.toBe("succeeded");
    await expect(client.readResult(connection, signal)).resolves.toEqual(Buffer.from("{}"));
    expect(fetcher.mock.calls[0][0].toString()).toBe("https://fixture.prod.colab.dev/scope/api/kernels");
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "X-Colab-Runtime-Proxy-Token": "test-only-proxy" });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ protocol: "wss:", pathname: "/scope/api/kernels/kernel-1/channels" }),
      "test-only-proxy", "print(1)", expect.any(String), signal);
    await expect(client.readResult({ ...connection, url: "https://fake.colab.dev.example.test/" }, signal)).rejects.toThrow(/connection_invalid/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
