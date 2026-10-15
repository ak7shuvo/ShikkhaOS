import { setupRole } from '../migrate.js';

const url = process.env.PROVISIONER_DATABASE_URL;
const pw = process.env.CONTROL_APP_PASSWORD;
if (!url || !pw) {
  console.error('PROVISIONER_DATABASE_URL and CONTROL_APP_PASSWORD are required (see .env.example).');
  process.exit(1);
}
await setupRole(url, 'petra_control_app', pw);
console.log('Role petra_control_app is ready. Make sure CONTROL_DATABASE_URL uses it with the same password.');
