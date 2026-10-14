import { migrate } from '../migrate.js';

// Legacy shared school database only. Dedicated school databases are migrated with `npm run petra -- migrate <slug|--all>`.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required (shared/legacy database; see .env.example).');
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
