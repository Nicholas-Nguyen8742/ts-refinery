import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './index';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[db] DATABASE_URL is required to run migrations');
  process.exit(1);
}

const db = createDb(databaseUrl);
await migrate(db, { migrationsFolder: './drizzle' });
console.log('[db] migrations applied');
process.exit(0);
