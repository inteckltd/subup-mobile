# PitchIn mobile (Expo)

React Native app. Talks to Supabase (Auth, Postgres, Storage, Edge Functions).

## Run

```bash
# from repo root
npm install
cp mobile/.env.example mobile/.env
npm run dev:mobile
```

```
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
EXPO_PUBLIC_SENTRY_DSN=              # optional
```

`npm run lint` and `npx tsc --noEmit` from this directory.

## Docs (repo root)

- [Development](../docs/DEVELOPMENT.md) — Auth dashboard, migrations, types
- [Security](../docs/SECURITY.md) — RLS, rate limits, phone confirm
- [EAS and secrets](../docs/EAS_AND_SECRETS.md) — Twilio, cron Vault, function deploy
- [iOS](../docs/IOS_APP_STORE.md) · [Android](../docs/ANDROID_PLAY_STORE.md)
- [Launch remaining](../docs/TEMP_CATEGORY_1_LAUNCH.md)

**Do not** run seed SQL on production. Never commit a service-role key.
