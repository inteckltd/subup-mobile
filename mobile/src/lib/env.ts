import { z } from 'zod';

const FALLBACK_INVITE_APP_URL = 'https://www.subupapp.co.uk';

const envSchema = z.object({
  EXPO_PUBLIC_SUPABASE_URL: z.string().url({ message: 'EXPO_PUBLIC_SUPABASE_URL must be a valid URL' }),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1, 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),
  EXPO_PUBLIC_SENTRY_DSN: z.string().optional(),
  EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  EXPO_PUBLIC_INVITE_APP_URL: z.string().url({ message: 'EXPO_PUBLIC_INVITE_APP_URL must be a valid URL' }).optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
    EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_INVITE_APP_URL: process.env.EXPO_PUBLIC_INVITE_APP_URL || undefined,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(
      `Missing or invalid environment variables. Copy .env.example to .env and fill in your Supabase project values:\n${issues}`,
    );
  }

  return {
    ...parsed.data,
    EXPO_PUBLIC_INVITE_APP_URL: parsed.data.EXPO_PUBLIC_INVITE_APP_URL ?? FALLBACK_INVITE_APP_URL,
  };
}

export const env = loadEnv();
