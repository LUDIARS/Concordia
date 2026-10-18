import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskflowFailurePanel } from './TaskflowFailurePanel.js';

describe('session failure panel', () => {
  it('shows a persisted observation without claiming the problem is resolved', () => {
    const html = renderToStaticMarkup(<TaskflowFailurePanel value={{ version: 1, observed_at: 123,
      operation: 'revisor-notice', reason: 'taskflow_internal_error', message: 'token=private-value' }} />);
    expect(html).toContain('審査結果を受け取った後の処理');
    expect(html).toContain('taskflow_internal_error');
    expect(html).toContain('解消したかどうかは未確認');
    expect(html).not.toContain('private-value');
  });
  it('ignores missing and malformed snapshots', () => {
    expect(renderToStaticMarkup(<TaskflowFailurePanel value={null} />)).toBe('');
    expect(renderToStaticMarkup(<TaskflowFailurePanel value={{ version: 1, observed_at: 'bad' }} />)).toBe('');
  });
});
