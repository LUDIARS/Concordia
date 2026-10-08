import { afterEach, expect, it, vi } from "vitest";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { api } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

it("sends JSON Content-Type for a bodyless DELETE accepted by the browser guard", async () => {
  const env = makeTestApp();
  env.staff.upsertManual({ platform: "discord", platformUserId: "local-user", role: "manager" });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    // Browser/network supplies Host; preserve the actual API client's other headers.
    headers.set("host", "localhost");
    return env.app.request(new Request(`http://localhost${url}`, { ...init, headers }));
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await api.staffDelete("discord", "local-user")).toEqual({ ok: true });
  expect(env.staff.roleOf("discord", "local-user")).toBeNull();
  const [, init] = fetchMock.mock.calls[0];
  expect(init?.method).toBe("DELETE");
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  expect(init?.body).toBeUndefined();
});
