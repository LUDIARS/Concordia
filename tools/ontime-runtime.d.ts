export interface ObservedContract<Args extends unknown[], Result> {
  contractId: string;
  post?: (result: Result, ...args: Args) => boolean;
  id?: string;
  where?: string;
  rule?: string;
}
export declare function contract<Args extends unknown[], Result>(
  fn: (...args: Args) => Result, spec: ObservedContract<Args, Result>,
): (...args: Args) => Result;
