type Input = {
  approved: boolean; code: string; data: string; destination: string; expectedDestination: string;
  now: number; deadline: number; maxSeconds: number; unitsPerMinute: number; maxUnits: number;
};

export default {
  post(result: unknown, input: Input): boolean {
    const seconds = (input.deadline - input.now) / 1000;
    if (!input.approved || input.code !== "public" || input.data !== "non_confidential"
      || input.destination !== input.expectedDestination) return result === "classification";
    if (!(seconds > 0 && seconds <= input.maxSeconds)) return result === "deadline";
    return result === (seconds / 60 * input.unitsPerMinute <= input.maxUnits ? "allowed" : "usage");
  },
};
