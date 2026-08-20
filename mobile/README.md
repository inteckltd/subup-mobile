# PitchIn mobile (Expo)

React Native app. Talks to Supabase (Auth, Postgres, Storage, Edge Functions).

## Run

```bash
# from repo root
npm install
cp mobile/.env.example mobile/.env   # fill in keys
npm run dev:mobile
```

Required in `mobile/.env`:

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
EXPO_PUBLIC_SENTRY_DSN=              # optional
```

`npm run lint` and `npx tsc --noEmit` from this directory.

## Auth (Dashboard)

Password-only: email is stored as `mobile@users.pitchin.app` (`mobile/src/lib/phone.ts`).

On the Supabase project:

- Authentication → Providers → Email: **enabled**, Confirm email **off**
- Minimum password length **8**
- Phone / Apple / Google providers: **off**
- Auth rate limits (sign-in / sign-up) stay at Dashboard defaults — there is no extra app-level limiter

SMS OTP, forgot-password, and social sign-in are not in the app. See `docs/AUTH_BACKLOG.md`.

## Schema

Apply in order under `supabase/migrations/` (`001`–`019`). After a schema change, regenerate types:

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

Storage buckets `avatars` and `group-covers` are created by migrations.

**Do not** run `supabase/seed_test_data.sql` on production.

## Edge Functions

Deploy all of:

```bash
supabase functions deploy notify-game-created
supabase functions deploy notify-game-lifecycle
supabase functions deploy notify-group-invite
supabase functions deploy notify-score-updated
supabase functions deploy notify-waitlist-promoted
supabase functions deploy update-my-mobile
supabase functions deploy delete-my-account
supabase functions deploy apply-game-lock
supabase functions deploy close-motm-votes
supabase functions deploy send-score-reminders
```

Secrets (Dashboard or CLI):

```bash
supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
supabase secrets set SENTRY_DSN=<sentry-ingest-dsn>
```

The three cron functions (`apply-game-lock`, `close-motm-votes`, `send-score-reminders`) have `verify_jwt = false` in `supabase/config.toml` and must still check `x-cron-secret`. Do not add more unverified functions. `update-my-mobile` verifies the caller JWT in code; leave its gateway setting as deployed.

### Cron Vault (once per project)

After setting `CRON_SECRET`, store URLs in Vault (SQL Editor — not a git migration):

```sql
select vault.create_secret(
  'https://<project-ref>.functions.supabase.co/send-score-reminders',
  'score_reminder_function_url'
);
select vault.create_secret('<same as CRON_SECRET>', 'score_reminder_cron_secret');
select vault.create_secret(
  'https://<project-ref>.functions.supabase.co/close-motm-votes',
  'motm_close_function_url'
);
select vault.create_secret(
  'https://<project-ref>.functions.supabase.co/apply-game-lock',
  'apply_game_lock_function_url'
);
```

Without these, RPCs still work; only the unattended sweeps fail.

## Sentry

1. Create a **pitchin** project in the **inteck** org (`https://inteck.sentry.io`).
2. Put the DSN in `EXPO_PUBLIC_SENTRY_DSN` (mobile) and `SENTRY_DSN` (Edge Functions secret).
3. Production EAS builds upload source maps via the `@sentry/react-native/expo` plugin in `app.json`. Set `SENTRY_AUTH_TOKEN` in EAS secrets so upload works.

## Push (EAS)

Physical device + `eas.json` `preview`/`production` profiles. `development` skips the push plugin so Expo Go still works.

```bash
npx eas-cli@latest login
npx eas-cli@latest build --platform ios --profile production
```

## RLS notes

- `anon` is revoked on domain tables. `is_email_taken` stays granted to `anon` (boolean only).
- Game/player/notification writes go through security-definer RPCs (`search_path = public, pg_temp`).
- Profile stats (`global_mmr`, `games_played`, `motm_count`, `reliability_score`) cannot be updated by the client (`protect_profile_stats`).
- Storage writes are scoped to `{auth.uid()}/...`.
- Account deletion is `delete-my-account` (JWT + service role), not a client `DELETE`.
