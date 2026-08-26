# SubUp

UK mobile app for private sports groups: schedule games, join or leave with a lock window, enter scores, vote MOTM, track MMR.

```
mobile/     Expo (iOS + Android)
supabase/   Postgres, RLS, Edge Functions
docs/       Product, security, deploy, launch lists
```

The app talks to Supabase (RLS + RPCs). Push, cron, SMS, and account deletion run as Edge Functions.

## Run

```bash
npm install
cp mobile/.env.example mobile/.env   # URL + publishable key
npm run dev:mobile
```

Never commit `.env` or a service-role key. Never run seed SQL on production.

## Docs

- [Product](docs/PRODUCT.md)
- [Local development](docs/DEVELOPMENT.md)
- [Security](docs/SECURITY.md)
- [EAS and secrets](docs/EAS_AND_SECRETS.md)
- [iOS App Store](docs/IOS_APP_STORE.md)
- [Android Play Store](docs/ANDROID_PLAY_STORE.md)
- [Legal / support site](site/README.md) — Terms, Privacy, and the store support URL
- [Brand](docs/BRAND.md) — colours, type, logo brief for marketing
- [Category 1 — required before launch](docs/TEMP_CATEGORY_1_LAUNCH.md)
- [Category 2 — future features](docs/TEMP_CATEGORY_2_FUTURE.md)
