# Local development

## Prerequisites

- Node 22+
- Expo Go or a dev client (`eas.json` `development` profile)
- A Supabase project (region **eu-west-2** when you create production)

## Mobile

From the repo root:

```bash
npm install
cp mobile/.env.example mobile/.env
npm run dev:mobile
```

Required in `mobile/.env`:

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
EXPO_PUBLIC_SENTRY_DSN=              # optional
```

From `mobile/`:

```bash
npm run lint
npx tsc --noEmit
```

CI runs the same two checks (`.github/workflows/ci.yml`).

## Auth dashboard (this project)

- Email provider: **on**, Confirm email **off**
- Phone provider: **on**, Confirm phone **off** (sign-up is password-only; one-time SMS confirm is in-app)
- Twilio Programmable SMS (not Verify) for Auth OTP
- Minimum password length **8**
- Apple / Google: **off**

After sign-up the app sends an SMS OTP and calls `confirm_my_mobile()` so `profiles.mobile_verified_at` is set. Existing profiles were grandfathered in migration `022`.

## Schema

Apply migrations in order under `supabase/migrations/` (`001`–`022`). After a schema change, regenerate types if you use the CLI:

```bash
npx supabase gen types typescript --linked > mobile/src/types/database.ts
```

Hand-written extras live in `mobile/src/types/database.ts` — keep RPC row shapes in sync.

Storage buckets `avatars` and `group-covers` are created by migrations.

**Do not** run `supabase/seed_test_data.sql` or `supabase/seed_app_review_user.sql` on production.

## Edge Functions

Deploy list and secrets: [EAS_AND_SECRETS.md](EAS_AND_SECRETS.md).
