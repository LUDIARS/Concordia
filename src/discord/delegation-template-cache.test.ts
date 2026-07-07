import { describe, expect, it } from "vitest";
import {
  DELEGATION_TEMPLATE_CACHE_TTL_MS,
  DelegationTemplateCache,
  type DelegationTemplateLite,
} from "./delegation-template-cache.js";

const log = {
  info: () => {},
  warn: () => {},
};

function template(callName: string): DelegationTemplateLite {
  return {
    call_name: callName,
    title: callName,
    is_active: true,
    call_only: false,
    emoji: "",
  };
}

describe("DelegationTemplateCache", () => {
  it("keeps delegation templates for the default 7 day TTL", async () => {
    let now = 1000;
    let calls = 0;
    const cache = new DelegationTemplateCache({
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return [template(`tpl-${calls}`)];
      },
    });

    expect(await cache.get("http://cc", log)).toMatchObject({
      source: "fresh",
      templates: [{ call_name: "tpl-1" }],
    });

    now += DELEGATION_TEMPLATE_CACHE_TTL_MS - 1;
    expect(await cache.get("http://cc", log)).toMatchObject({
      source: "cache",
      templates: [{ call_name: "tpl-1" }],
    });
    expect(calls).toBe(1);
  });

  it("returns stale data after TTL while refreshing in the background", async () => {
    let now = 1000;
    let calls = 0;
    const cache = new DelegationTemplateCache({
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return [template(`tpl-${calls}`)];
      },
    });

    await cache.get("http://cc", log);
    now += DELEGATION_TEMPLATE_CACHE_TTL_MS + 1;
    const stale = await cache.get("http://cc", log);
    expect(stale).toMatchObject({
      source: "stale",
      refreshing: true,
      templates: [{ call_name: "tpl-1" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.get("http://cc", log)).toMatchObject({
      source: "cache",
      templates: [{ call_name: "tpl-2" }],
    });
    expect(calls).toBe(2);
  });

  it("keeps stale data available after invalidate while refreshing", async () => {
    let calls = 0;
    let resolveRefresh: ((templates: DelegationTemplateLite[]) => void) | null = null;
    const cache = new DelegationTemplateCache({
      fetcher: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([template("tpl-1")]);
        return new Promise<DelegationTemplateLite[]>((resolve) => {
          resolveRefresh = resolve;
        });
      },
    });

    await cache.get("http://cc", log);
    cache.invalidate();
    const stale = await cache.get("http://cc", log);

    expect(stale).toMatchObject({
      source: "stale",
      refreshing: true,
      templates: [{ call_name: "tpl-1" }],
    });
    expect(calls).toBe(2);

    if (!resolveRefresh) throw new Error("refresh was not started");
    resolveRefresh([template("tpl-2")]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await cache.get("http://cc", log)).toMatchObject({
      source: "cache",
      templates: [{ call_name: "tpl-2" }],
    });
  });

  it("fetches again after clear", async () => {
    let calls = 0;
    const cache = new DelegationTemplateCache({
      fetcher: async () => {
        calls += 1;
        return [template(`tpl-${calls}`)];
      },
    });

    await cache.get("http://cc", log);
    cache.clear();
    expect(await cache.get("http://cc", log)).toMatchObject({
      source: "fresh",
      templates: [{ call_name: "tpl-2" }],
    });
    expect(calls).toBe(2);
  });
});
