// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getViewerBasename } from "./viewer-basename.js";

function documentWithMarker(prefix?: string): Document {
  const document = window.document.implementation.createHTMLDocument();
  const marker = document.createElement("script");
  marker.dataset.excubitorViewer = "";
  if (prefix !== undefined) marker.dataset.prefix = prefix;
  document.body.append(marker);
  return document;
}

describe("getViewerBasename", () => {
  it("preserves direct access when Ex did not inject a marker", () => {
    const document = window.document.implementation.createHTMLDocument();

    expect(getViewerBasename(document)).toBeUndefined();
  });

  it("returns a normalized same-origin path", () => {
    expect(getViewerBasename(documentWithMarker("/services/concordia/")))
      .toBe("/services/concordia");
  });

  it.each([
    undefined,
    "",
    "services/concordia",
    "//example.test/concordia",
    "/services/../admin",
    "/services/%2e%2e/admin",
    "/services\\concordia",
    "/services/concordia?tab=work",
    "/services/concordia#work",
  ])(
    "rejects an invalid injected prefix (%s)",
    (prefix) => {
      expect(() => getViewerBasename(documentWithMarker(prefix))).toThrow(
        "data-prefix to be an absolute same-origin path",
      );
    },
  );
});
