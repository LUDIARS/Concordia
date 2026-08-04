/**
 * Extract the TestWorkflow surface correlation written during session enrollment.
 * @implements spec/feature/test-forum-controls.md — 実装範囲 (テスト開始)
 */
export function readTestSurfaceId(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as { test_surface_id?: unknown }).test_surface_id;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
