export interface MutationOptions<T> {
  action: () => Promise<T>;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  confirmMessage?: string;
  errorPrefix?: string;
  onSuccess?: (value: T) => Promise<void> | void;
}

/** Shared busy/error/confirm boundary for UI mutations. */
export async function runMutation<T>(options: MutationOptions<T>): Promise<T | undefined> {
  if (options.confirmMessage && !window.confirm(options.confirmMessage)) return undefined;
  options.setError(null);
  options.setBusy(true);
  try {
    const value = await options.action();
    await options.onSuccess?.(value);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.setError(`${options.errorPrefix ?? ""}${message}`);
    return undefined;
  } finally {
    options.setBusy(false);
  }
}

export async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
}
