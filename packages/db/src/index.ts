import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * from './schema';

export type RefineryDb = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string): RefineryDb {
  const client = postgres(databaseUrl, {
    max: 10,
    // Silence "no schema has been selected for search path"-style NOTICE spam.
    onnotice: () => {},
  });
  return drizzle(client, { schema });
}
