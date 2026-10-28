export default {
  post(result: string, value: unknown): boolean {
    return typeof result === "string" && !/[<>\[\]`*\\\r\n]/.test(result)
      && (String(value).length === 0 || result.length > 0);
  },
};
