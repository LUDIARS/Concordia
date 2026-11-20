export default {
  post(result: unknown, allocationResolved: boolean, absent: boolean): boolean {
    return (result === "released") === (allocationResolved && absent);
  },
};
