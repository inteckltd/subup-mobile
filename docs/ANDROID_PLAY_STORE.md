# Android Play Store

Package: `com.inteck.pitchin`. Adaptive icon assets live in `mobile/assets/android-icon-*.png`. Background colour is brand green `#0B6E4F`.

## Signing and build

1. Play Console app + Play App Signing.
2. Let EAS generate an upload key, or supply your own. Store the keystore outside git (`.gitignore` already ignores `*.jks` / `*.keystore`-style files).
3. `npx eas-cli@latest build --platform android --profile production` from `mobile/`.
4. Upload the AAB to an **internal** track first, then closed, then production.

```bash
npx eas-cli@latest submit --platform android --profile production
```

## Play Console

- Privacy Policy **https URL**
- Data safety form (same processors as iOS: Supabase, Twilio, Expo, Sentry)
- Short / full description, feature graphic (1024×500), phone screenshots
- Target API level as required by Play
- `INVITE_APP_URL` can point at the Play listing or a landing page

Remaining store polish: [TEMP_CATEGORY_1_LAUNCH.md](TEMP_CATEGORY_1_LAUNCH.md).
