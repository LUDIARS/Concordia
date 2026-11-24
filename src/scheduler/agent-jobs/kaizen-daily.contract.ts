export default {
  post(result: { date: string; start: Date; end: Date }, firedAt: Date): boolean {
    const jst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", dateStyle: "short" });
    return result.start.getUTCHours() === 15 && result.start.getUTCMinutes() === 0
      && result.start.getUTCSeconds() === 0 && result.start.getUTCMilliseconds() === 0
      && result.end.getTime() - result.start.getTime() === 86_400_000
      && jst.format(result.end) === jst.format(firedAt)
      && result.date === new Date(result.start.getTime() + 32_400_000).toISOString().slice(0, 10);
  },
};
