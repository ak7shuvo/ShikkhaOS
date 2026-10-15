import { setupRole } from '../migrate.js';
import { assertOperatorUrls } from '../production-guards.js';

assertOperatorUrls(process.env, ['PROVISIONER_DATABASE_URL', 'MIGRATION_DATABASE_URL']); // production: verified TLS required

// Legacy shared-database role (Phase 1 layout). Only needed while any school is db_mode='shared'.
const url = process.env.PROVISIONER_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
const pw = process.env.APP_DB_PASSWORD;
if (!url || !pw) {
  console.error('PROVISIONER_DATABASE_URL (or MIGRATION_DATABASE_URL) and APP_DB_PASSWORD are required (see .env.example).');
  process.exit(1);
}
await setupRole(url, 'shikkha_app', pw);
console.log('Role shikkha_app is ready (shared/legacy database).');
