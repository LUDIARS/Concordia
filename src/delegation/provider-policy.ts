/**
 * Windows native Codex can leak logon sessions through CreateProcessWithLogonW.
 * Delegation must therefore use the Satelles/SDK lane even when a legacy caller
 * or persisted row still supplies the old logical provider name.
 *
 * @implements spec/feature/delegation.md §13.2 (`SPEC-DELEGATION-CODEX-SDK`)
 */
export function sdkSafeDelegationProvider<TProvider extends string>(
  provider: TProvider,
): Exclude<TProvider, "codex"> | "codex-sdk" {
  return (provider === "codex" ? "codex-sdk" : provider) as Exclude<TProvider, "codex"> | "codex-sdk";
}
