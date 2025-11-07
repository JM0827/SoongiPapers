// server/config/env.ts
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.string().default('8080'),
  REDIS_URL: z.string().url(),
});

export const env = schema.parse(process.env);