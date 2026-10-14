import { z } from 'zod';
import { badRequest } from './errors.js';

/** WCAG relative luminance contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((s) => s.toLowerCase());

export const brandingSchema = z.object({
  display_name: z.string().trim().min(2).max(80),
  logo_url: z
    .string()
    .url()
    .max(500)
    .regex(/^https:\/\//)
    .nullable()
    .default(null),
  primary_color: hex,
  accent_color: hex,
});
export type Branding = z.infer<typeof brandingSchema>;

/** Validates branding input; colours must keep white button text readable (WCAG AA 4.5:1). */
export function validateBranding(input: unknown): Branding {
  const r = brandingSchema.safeParse(input);
  if (!r.success)
    throw badRequest(
      'VALIDATION_ERROR',
      'Invalid branding',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  for (const [k, v] of [
    ['primary_color', r.data.primary_color],
    ['accent_color', r.data.accent_color],
  ] as const) {
    if (contrastRatio(v, '#ffffff') < 4.5) throw badRequest('LOW_CONTRAST', `${k} must have at least 4.5:1 contrast against white text`, { field: k });
  }
  return r.data;
}
