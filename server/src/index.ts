import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertRestrictedRole, createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await assertRestrictedRole(pool);
const app = await buildApp(config, pool);
await app.listen({ port: config.PORT, host: config.HOST });
