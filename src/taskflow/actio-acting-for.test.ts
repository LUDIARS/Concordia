/** @implements Actio spec/feature/cc-acting-for.md — Cc requester header for Actio writes */

import { describe, expect, it } from "vitest";
import { ACTING_FOR_HEADER, actingForHeaders, withActingFor } from "./actio-acting-for.js";

describe("actingForHeaders", () => {
  it("is empty outside a requester scope", () => {
    expect(actingForHeaders()).toEqual({});
  });

  it("carries the requester across awaits inside the scope", async () => {
    const headers = await withActingFor({ platform: "discord", userId: "123" }, async () => {
      await Promise.resolve();
      return actingForHeaders();
    });
    expect(headers).toEqual({ [ACTING_FOR_HEADER]: "discord:123" });
    expect(actingForHeaders()).toEqual({});
  });

  it("omits a null or malformed requester", async () => {
    expect(await withActingFor(null, async () => actingForHeaders())).toEqual({});
    expect(await withActingFor({ platform: "slack", userId: "a b\nc" }, async () => actingForHeaders())).toEqual({});
  });
});
