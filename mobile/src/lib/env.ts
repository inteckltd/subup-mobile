import { z } from 'zod';

const envSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: z.string().url({ message: 'EXPO_PUBLIC_SUPABASE_URL must be a valid URL' }),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),
  EXPO_PUBLIC_SENTRY_DSN: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(
      `Missing or invalid environment variables. Copy .env.example to .env and fill in your Supabase project values:\n${issues}`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();
