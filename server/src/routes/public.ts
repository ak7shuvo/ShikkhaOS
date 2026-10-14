import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../context.js';
import { notFound } from '../errors.js';
import { SLUG_RE } from '../registry.js';

const cmp = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** Unauthenticated, read-only, non-sensitive: only public branding and app configuration, looked up by slug. */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { control } = app.deps;
  const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  const find = async (slug: string) => {
    const r = (
      await control.query(
        `SELECT s.slug, b.display_name, b.logo_url, b.primary_color, b.accent_color FROM schools s JOIN school_branding b ON b.school_id = s.id
          WHERE s.slug = $1 AND s.status IN ('active','maintenance','suspended')`,
        [slug],
      )
    ).rows[0];
    if (!r) throw notFound('School');
    return r;
  };

  app.get('/public/branding/:slug', limit, async (req) => {
    const { slug } = parse(z.object({ slug: z.string().regex(SLUG_RE) }), req.params);
    return find(slug);
  });

  // Lets branded clients learn whether the installed app version is still supported.
  app.get('/public/app-config/:slug', limit, async (req) => {
    const { slug } = parse(z.object({ slug: z.string().regex(SLUG_RE) }), req.params);
    const { version } = parse(
      z.object({
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
      }),
      req.query,
    );
    const branding = await find(slug);
    const rel =
      (await control.query(`SELECT version, min_supported_version FROM app_releases WHERE channel = 'stable' ORDER BY created_at DESC LIMIT 1`)).rows[0] ??
      null;
    return {
      branding,
      latest_version: rel?.version ?? null,
      min_supported_version: rel?.min_supported_version ?? null,
      update_required: Boolean(version && rel && cmp(version, rel.min_supported_version) < 0),
    };
  });
}
