import { setupRole } from '../migrate.js';

const url = process.env.MIGRATION_DATABASE_URL;
const pw = process.env.APP_DB_PASSWORD;
if (!url || !pw) {
  console.error('MIGRATION_DATABASE_URL and APP_DB_PASSWORD are required (see .env.example).');
  process.exit(1);
}
await setupRole(url, pw);
console.log('Role shikkha_app is ready. Make sure DATABASE_URL uses it with the same password.');
