/** Predicate for the session hook reentry boundary. */
export default {
  post(result, input) {
    return result === null || result === `${input.hooksPath}/${input.hook}` || result === `${input.hooksPath}\\${input.hook}`;
  },
};
