import { z } from 'zod';

/**
 * Parse `process.env` against a Zod schema, exiting with a readable report on
 * failure. Env validation happens at the process boundary (app boot) so that
 * misconfiguration fails fast instead of surfacing mid-job.
 */
export function loadEnv<T>(schema: z.ZodType<T>): T {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`[config] Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return result.data;
}

/**
 * "true"/"false" env flag with correct semantics
 * (Boolean('false') === true is a classic foot-gun).
 */
export const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const DEFAULT_REDIS_URL = 'redis://localhost:6379';
