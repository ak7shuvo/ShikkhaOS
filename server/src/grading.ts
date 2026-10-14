import { z } from 'zod';

/**
 * Grading is entirely school-configured. There are NO built-in grade boundaries:
 * if an exam has no grading policy, results are published with grade = null.
 * A band applies when percentage >= min_percent; the highest matching min wins.
 */
export const gradingBandsSchema = z
  .array(
    z.object({
      min_percent: z.number().min(0).max(100),
      grade: z.string().min(1).max(10),
      grade_point: z.number().min(0).max(100).optional(),
    }),
  )
  .min(1)
  .refine((b) => b.some((x) => x.min_percent === 0), { message: 'a band with min_percent 0 is required' })
  .refine((b) => new Set(b.map((x) => x.min_percent)).size === b.length, { message: 'min_percent values must be unique' });

export type GradingBands = z.infer<typeof gradingBandsSchema>;

export interface GradeResult {
  percentage: number | null;
  grade: string | null;
  grade_point: number | null;
}

export function computeGrade(bands: GradingBands | null, obtained: number | null, max: number, absent: boolean): GradeResult {
  if (absent || obtained === null || max <= 0) return { percentage: null, grade: null, grade_point: null };
  const percentage = Math.round((obtained / max) * 10000) / 100;
  if (!bands) return { percentage, grade: null, grade_point: null };
  const band = [...bands].sort((a, b) => b.min_percent - a.min_percent).find((b) => percentage >= b.min_percent);
  return { percentage, grade: band?.grade ?? null, grade_point: band?.grade_point ?? null };
}
