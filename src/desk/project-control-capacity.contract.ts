export default {
  post(result: unknown, occupied: number): boolean {
    return result === (occupied < 2);
  },
};
