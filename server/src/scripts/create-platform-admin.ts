import pg from 'pg';
import { hashPassword, PASSWORD_MIN_LENGTH } from '../passwords.js';

const url = process.env.MIGRATION_DATABASE_URL;
const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!url || !email || !password || password.length < PASSWORD_MIN_LENGTH) {
  console.error(`MIGRATION_DATABASE_URL, PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (min ${PASSWORD_MIN_LENGTH} chars) are required.`);
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  await pool.query(`INSERT INTO users (email, password_hash, full_name, is_platform_admin) VALUES ($1,$2,'Platform Administrator',true)`, [
    email,
    await hashPassword(password),
  ]);
  console.log(`Platform admin ${email} created.`);
} finally {
  await pool.end();
}
