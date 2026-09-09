const VIEWER_SCRIPT_SELECTOR = "script[data-excubitor-viewer]";

function hasTraversalSegment(path: string): boolean {
  try {
    return decodeURIComponent(path)
      .split("/")
      .some((segment) => segment === "." || segment === "..");
  } catch {
    return true;
  }
}

/** Read the route prefix supplied by Ex, or leave direct access unchanged. */
export function getViewerBasename(root: ParentNode = document): string | undefined {
  const marker = root.querySelector<HTMLScriptElement>(VIEWER_SCRIPT_SELECTOR);
  if (!marker) return undefined;

  const prefix = marker.dataset.prefix;
  const isValidPath = prefix !== undefined
    && prefix.startsWith("/")
    && !prefix.startsWith("//")
    && !prefix.includes("\\")
    && !prefix.includes("?")
    && !prefix.includes("#")
    && !hasTraversalSegment(prefix);

  if (!isValidPath) {
    throw new Error("Ex Viewer requires data-prefix to be an absolute same-origin path");
  }

  return prefix === "/" ? prefix : prefix.replace(/\/+$/, "");
}
