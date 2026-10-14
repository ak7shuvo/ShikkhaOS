import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertRestrictedRole, createPool } from './db.js';
import { tlsOptions } from './tls.js';

const config = loadConfig();
const dbTls = tlsOptions(config.CONTROL_DB_SSL, config.DB_SSL_CA_FILE);
const control = createPool(config.CONTROL_DATABASE_URL, dbTls);
await assertRestrictedRole(control);
const sharedPool = config.SHARED_DATABASE_URL ? createPool(config.SHARED_DATABASE_URL, dbTls) : undefined;
if (sharedPool) await assertRestrictedRole(sharedPool);
const app = await buildApp(config, control, { sharedPool });
await app.listen({ port: config.PORT, host: config.HOST });
