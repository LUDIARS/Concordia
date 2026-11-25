/** Subscribe to browser events that can end a period without connectivity. */
export function onBrowserResume(refresh: () => void): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") refresh();
  };
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("focus", refresh);
    window.removeEventListener("online", refresh);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
