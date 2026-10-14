import { describe, expect, it } from 'vitest';
import { computeGrade, gradingBandsSchema } from '../src/grading.js';
import { TRANSITIONS } from '../src/workflow.js';

const bands = gradingBandsSchema.parse([
  { min_percent: 80, grade: 'A', grade_point: 4 },
  { min_percent: 0, grade: 'F', grade_point: 0 },
  { min_percent: 50, grade: 'C', grade_point: 2 },
]);

describe('grading', () => {
  it('picks the highest matching band, boundary inclusive', () => {
    expect(computeGrade(bands, 80, 100, false).grade).toBe('A');
    expect(computeGrade(bands, 79.99, 100, false).grade).toBe('C');
    expect(computeGrade(bands, 49, 100, false).grade).toBe('F');
  });
  it('uses percentage of the exam maximum', () => {
    expect(computeGrade(bands, 20, 25, false)).toEqual({ percentage: 80, grade: 'A', grade_point: 4 });
  });
  it('never invents a grade without a policy', () => {
    expect(computeGrade(null, 90, 100, false)).toEqual({ percentage: 90, grade: null, grade_point: null });
  });
  it('absent or missing marks have no grade', () => {
    expect(computeGrade(bands, null, 100, true).grade).toBeNull();
    expect(computeGrade(bands, null, 100, false).grade).toBeNull();
  });
  it('rejects bands lacking a zero floor or with duplicates', () => {
    expect(gradingBandsSchema.safeParse([{ min_percent: 50, grade: 'A' }]).success).toBe(false);
    expect(
      gradingBandsSchema.safeParse([
        { min_percent: 0, grade: 'A' },
        { min_percent: 0, grade: 'B' },
      ]).success,
    ).toBe(false);
  });
});

describe('workflow table', () => {
  it('only publish starts from approved; only approve/return start from under_review', () => {
    expect(TRANSITIONS.publish.from).toEqual(['approved']);
    expect(TRANSITIONS.approve.from).toEqual(['under_review']);
    expect(TRANSITIONS.return.from).toEqual(['under_review']);
    expect(TRANSITIONS.return.needsReason).toBe(true);
    expect(TRANSITIONS.open_correction.from).toEqual(['published']);
  });
});

