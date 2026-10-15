/**
 * Child process used by migration-recovery.test.ts to simulate a hard crash (SIGKILL) in the middle of a migration.
 * Usage: tsx test/crash-child.ts <schoolId> <mid-copy|after-commit>. Runs only with the guarded test environment.
 */
import { migrateSharedToDedicated } from '../src/shared-migration.js';
import { controlFixture } from './fixtures.js';
import { validateTestEnvironment } from './safety.js';

validateTestEnvironment(process.env);
const [schoolId, point] = process.argv.slice(2);
if (!schoolId || (point !== 'mid-copy' && point !== 'after-commit')) throw new Error('usage: crash-child <schoolId> <mid-copy|after-commit>');
const kill = (): void => {
  process.kill(process.pid, 'SIGKILL');
};
const f = await controlFixture();
await migrateSharedToDedicated(
  {
    ...f.deps,
    sharedOwnerUrl: process.env.TEST_MIGRATION_DATABASE_URL!,
    afterTable: (t) => {
      if (point === 'mid-copy' && t === 'marks') kill();
    },
    afterCommit: () => {
      if (point === 'after-commit') kill();
    },
  },
  schoolId,
);
