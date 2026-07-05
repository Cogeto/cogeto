import { Pool } from 'pg';
import type { Principal } from '@cogeto/shared';
import { createDb } from '../infrastructure/index';
import { createMemoryStore, MemoryObjectStore, seedObjectFixture } from '../memory/index';
import { loadConfig } from './config';

/**
 * seed:object — DEV-ONLY (excluded from production images, see the Dockerfile
 * runtime stage). Places one object in MinIO with a matching file_metadata row
 * and one derived memory, so the deletion saga's object-removal leg is
 * exercisable before file upload exists (arrives in O1).
 *
 * Usage:
 *   npm run seed:object -- --owner <zitadel user id> --org <zitadel org id>
 *
 * The owner id must be YOUR user id (GET /api/me shows it) — the saga is
 * owner-only, so an object seeded for someone else cannot be deleted by you.
 */
async function main(): Promise<void> {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length - 1; i += 1) {
    const flag = argv[i]!;
    if (flag.startsWith('--')) args.set(flag.slice(2), argv[i + 1]!);
  }
  const ownerId = args.get('owner') ?? process.env.COGETO_SEED_OWNER;
  const orgId = args.get('org') ?? process.env.COGETO_SEED_ORG;
  if (!ownerId || !orgId) {
    console.error(
      'usage: npm run seed:object -- --owner <user id> --org <org id>\n' +
        '(GET /api/me while logged in shows both; the saga is owner-only)',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = createDb(pool);
    const store = createMemoryStore({ db });
    const objects = new MemoryObjectStore({
      url: config.s3Url,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
      bucket: config.s3Bucket,
    });
    const principal: Principal = {
      userId: ownerId,
      name: 'seed:object',
      email: null,
      orgId,
      orgName: 'seed',
      roles: [],
    };
    await objects.ensureBucket();
    const { objectKey, memory } = await seedObjectFixture({ db, store, objects, principal });
    console.log('seeded dev object for the deletion saga demo:');
    console.log(`  object key : ${objectKey}`);
    console.log(`  memory id  : ${memory.id}`);
    console.log(
      `  delete via : DELETE /api/sources/file/${encodeURIComponent(objectKey)} (owner-only)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('seed:object failed:', error);
  process.exit(1);
});
