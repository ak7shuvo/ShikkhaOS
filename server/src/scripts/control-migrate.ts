import { CONTROL_MIGRATIONS_DIR, migrate } from '../migrate.js';
import { assertOperatorUrls } from '../production-guards.js';

assertOperatorUrls(process.env, ['CONTROL_MIGRATION_DATABASE_URL']); // production: verified TLS required

const url = process.env.CONTROL_MIGRATION_DATABASE_URL;
if (!url) {
  console.error('CONTROL_MIGRATION_DATABASE_URL is required (see .env.example).');
  process.exit(1);
}
const applied = await migrate(url, { dir: CONTROL_MIGRATIONS_DIR, lockKey: 727002 });
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Control plane is up to date.');
