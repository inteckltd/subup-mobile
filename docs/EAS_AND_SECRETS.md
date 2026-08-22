# EAS, Supabase secrets, and cron

## Expo EAS

```bash
cd mobile
npx eas-cli@latest login
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest build --platform android --profile production
```

Profiles in `mobile/eas.json`:

- `development` — dev client, internal, skips some production plugins so Expo Go still works for day-to-day
- `preview` — internal distribution
- `production` — store builds, `autoIncrement: true`

Push needs a physical device and `preview` / `production`.

### EAS secrets / env

Set the same `EXPO_PUBLIC_*` values the app needs at build time (EAS Environment or `eas secret:create`):

```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
EXPO_PUBLIC_SENTRY_DSN
SENTRY_AUTH_TOKEN          # source maps via the Sentry Expo plugin
```

`SENTRY_ALLOW_FAILURE` is `true` on preview/production today so a missing token does not fail the build. Watch Sentry uploads before a real store ship.

## Supabase Edge Function secrets

```bash
supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
supabase secrets set SENTRY_DSN=<sentry-ingest-dsn>
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxxxxx
supabase secrets set TWILIO_AUTH_TOKEN=xxxxxxxx
supabase secrets set TWILIO_FROM_NUMBER=+44xxxxxxxxxx
supabase secrets set INVITE_APP_URL=https://your-testflight-or-landing-url
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.

Deploy:

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

## Twilio

Same Account SID + Auth Token go in **two** places (never commit them):

1. Dashboard → Authentication → Providers → Phone → Twilio
2. Edge Function secrets (invite SMS + phone-change OTP)

Trial: enable UK geo, verify destination numbers, expect the trial prefix. Production: paid sender, no trial prefix. Alphanumeric `PitchIn` needs a paid account.

`INVITE_APP_URL` is the download link in invite texts (TestFlight, Play internal track, or a landing page).

## Cron Vault (once per project)

`CRON_SECRET` (already set via `supabase secrets set`) lives on the **Edge Function**. Postgres cron cannot read that. It reads **Supabase Vault** — a separate key store inside the database — to learn the function **URL** and which secret to put on the `x-cron-secret` header.

So you need both:

1. `CRON_SECRET` on the function (you have this)
2. Vault rows below, so `pg_cron` can POST to those URLs with **the same value** as `CRON_SECRET`

Do this once in the SQL Editor (not a git migration). Replace `<project-ref>` and paste your existing `CRON_SECRET` into the second statement:

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

1. Project **pitchin** in the **inteck** org.
2. DSN in `EXPO_PUBLIC_SENTRY_DSN` and `SENTRY_DSN`.
3. Production EAS uploads source maps when `SENTRY_AUTH_TOKEN` is set.
