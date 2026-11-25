/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-02 */
import { describeTaskflowFailure } from "./failure.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4d2cffd6 */
import augurContract_8cc17556 from './actio-overview-pages.contract.js'; /* augur-inject:contract-predicate:9fab4c45 */

export interface ActioOverviewPages<T> {
  tasks: T[];
  partialReason?: string;
}

export function overviewPageFailure(completedPages: number, code: string): string | undefined {
  if (completedPages > 0 && (
    code === "actio_read_timeout" || code === "actio_unreachable" || code === "actio_response_invalid"
  )) return code;
  return undefined;
}
// @ts-expect-error augur-inject
overviewPageFailure = contract(overviewPageFailure, { ...augurContract_8cc17556, contractId: 'actio-overview-C-2', mode: 'observe', sample: 1, where: 'src/taskflow/actio-overview-pages.ts:9', rule: 'contract-wrap', id: '8cc17556' }); /* augur-inject:contract-wrap:8cc17556 */

export async function readActioOverviewPages<T>(pages: AsyncIterable<T[]>): Promise<ActioOverviewPages<T>> {
  const tasks: T[] = [];
  let completedPages = 0;
  try {
    for await (const page of pages) {
      tasks.push(...page);
      completedPages++;
    }
  } catch (error) {
    const partialReason = overviewPageFailure(completedPages, describeTaskflowFailure(error).code);
    if (!partialReason) throw error;
    return { tasks, partialReason };
  }
  return { tasks };
}
