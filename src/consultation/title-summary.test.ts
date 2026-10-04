import { describe, expect, it } from 'vitest';
import { chooseConsultationTitle, consultationTitlePrompt, publicConsultationTitleEligible } from './title-summary.js';
describe('public consultation title policy', () => {
  it('excludes private, unrelated, archived and other organization surfaces', () => {
    const eligible = { thread: true, departmentActive: true, useCaseActive: true, intakeEnabled: true, organizationMatches: true, privateConsultation: false };
    expect(publicConsultationTitleEligible(eligible)).toBe(true);
    for (const field of Object.keys(eligible) as (keyof typeof eligible)[]) {
      expect(publicConsultationTitleEligible({ ...eligible, [field]: !eligible[field] })).toBe(false);
    }
  });
  it('summarizes initially and preserves a thin topic change', () => {
    expect(chooseConsultationTitle({ title: '予算の相談', changed: false }, null)).toBe('予算の相談');
    expect(chooseConsultationTitle({ title: '予算について', changed: false }, '予算の相談')).toBe('予算の相談');
    expect(chooseConsultationTitle({ title: '接続障害', changed: true }, '予算の相談')).toBe('接続障害');
  });
  it('rejects invalid names instead of echoing input', () => {
    for (const value of [null, {}, { title: '@everyone', changed: true }, { title: '長'.repeat(49), changed: true },
      { title: '題\n名', changed: true }, { title: '相談', changed: 'false' }]) expect(chooseConsultationTitle(value, null)).toBeNull();
    const prompt = consultationTitlePrompt('長'.repeat(3000), '予算');
    expect(prompt).toContain('ツールは使用しない');
    expect(prompt).not.toContain('長'.repeat(2001));
  });
});
