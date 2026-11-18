import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { env } from '../env';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const g = globalThis as unknown as { __db?: Promise<DB> };

async function connect(): Promise<DB> {
  const e = env();
  if (e.DATABASE_URL) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    // prepare: false is required by Supabase's transaction pooler.
    const client = postgres(e.DATABASE_URL, { prepare: false, max: 5 });
    return drizzle(client, { schema }) as unknown as DB;
  }
  // Local development and tests: Postgres compiled to WebAssembly, stored on disk.
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const fs = await import('node:fs');
  fs.mkdirSync(path.dirname(path.resolve(e.PGLITE_DIR)), { recursive: true });
  const client = new PGlite(e.PGLITE_DIR);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  return db as unknown as DB;
}

export function db(): Promise<DB> {
  if (!g.__db) g.__db = connect();
  return g.__db;
}

export { schema };
