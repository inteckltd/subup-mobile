# PitchIn

UK mobile app for private sports groups: schedule games, join/leave with a lock window, enter scores, vote MOTM, track MMR.

**Not built:** Stripe, forgot password, SMS OTP, Apple/Google sign-in.

```
mobile/     Expo app
supabase/   Postgres + Edge Functions
docs/       Product spec
```

The app talks to Supabase (RLS + RPCs). Push, cron, and account deletion run as Edge Functions.

## Run

```bash
npm install
cp mobile/.env.example mobile/.env   # URL + publishable key
npm run dev:mobile
```

Never commit `.env` or a service-role key. Never run `supabase/seed_test_data.sql` on production.

Deploy, secrets, and EAS: [`mobile/README.md`](mobile/README.md).
