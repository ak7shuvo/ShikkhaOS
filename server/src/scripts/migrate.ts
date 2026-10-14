import { migrate } from '../migrate.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required (see .env.example).');
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
