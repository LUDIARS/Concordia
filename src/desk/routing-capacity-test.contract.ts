export default {
  post(result: {
    beforeCompletion: string[];
    afterCompletion: string[];
    requestIds: string[];
    thirdDelivery: string | null | undefined;
    firstState: string | undefined;
  }): boolean {
    const [first, second, third] = result.requestIds;
    return result.beforeCompletion.length === 2
      && result.beforeCompletion[0] === first && result.beforeCompletion[1] === second
      && result.thirdDelivery === "waiting" && result.firstState === "finished"
      && result.afterCompletion.length === 3 && result.afterCompletion[2] === third;
  },
};
