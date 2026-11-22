export default {
  post(result: string | undefined, header: (name: string) => string | undefined | null): boolean {
    const primary = header("x-excubitor-token")?.trim();
    const fallback = header("authorization")?.trim();
    const expected = primary ? primary : (fallback || undefined);
    return result === expected;
  },
};
