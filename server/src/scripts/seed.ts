import pg from 'pg';
import { seedSchool } from '../seed-data.js';

const url = process.env.MIGRATION_DATABASE_URL;
const password = process.env.DEV_SEED_PASSWORD;
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data when NODE_ENV=production.');
  process.exit(1);
}
if (!url || !password || password.length < 10) {
  console.error('MIGRATION_DATABASE_URL and DEV_SEED_PASSWORD (min 10 chars) are required. See .env.example.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const exists = await pool.query(`SELECT 1 FROM schools WHERE code = 'demo-school'`);
  if (exists.rowCount) {
    console.log('Demo school already seeded; nothing to do.');
  } else {
    const s = await seedSchool(pool, { code: 'demo-school', name: 'Demo School', password });
    console.log('Seeded demo school. Logins (password = DEV_SEED_PASSWORD):');
    for (const [role, u] of Object.entries(s.users)) console.log(`  ${role.padEnd(10)} ${u.email}`);
  }
} finally {
  await pool.end();
}
