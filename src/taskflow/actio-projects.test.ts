import { describe, expect, it, vi } from "vitest";
import { listLocalActioProjects } from "./actio-projects.js";
import { ActioTransport } from "./actio-transport.js";

const project = { code: "El", name: "Elegantia", teamIds: [] };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Actio project registration adapter", () => {
  it("verifies local identity before fetching registrations from the catalog endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ id: "actio-local", localMode: true, access: "loopback" }))
      .mockResolvedValueOnce(response({ projects: [project] }));
    const token = vi.fn();
    const transport = new ActioTransport({ findService: async () => ({ name: "actio", state: "running", port: 17880 }) } as never,
      token, fetchImpl as never);
    expect(await listLocalActioProjects(transport)).toEqual([project]);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "http://127.0.0.1:17880/api/auth/me", "http://127.0.0.1:17880/api/projects/cc",
    ]);
    expect(token).not.toHaveBeenCalled();
  });

  it.each([{}, { projects: [{}] }, { projects: [{ ...project, teamIds: null }] }])(
    "rejects malformed registration responses: %j", async body => {
      await expect(listLocalActioProjects({ request: vi.fn().mockResolvedValue(body) }))
        .rejects.toThrow("Invalid Actio project list response");
    },
  );

  it("rejects duplicate codes instead of choosing the first registration", async () => {
    await expect(listLocalActioProjects({ request: vi.fn().mockResolvedValue({ projects: [project, project] }) }))
      .rejects.toThrow("ambiguous");
  });

  it("does not interpret an unavailable service as an empty project list", async () => {
    await expect(listLocalActioProjects({ request: vi.fn().mockRejectedValue(new Error("service unavailable")) }))
      .rejects.toThrow("service unavailable");
  });
});
