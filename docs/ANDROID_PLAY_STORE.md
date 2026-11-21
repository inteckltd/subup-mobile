# Android Play Store

Package: `com.inteck.subup`. Adaptive icon assets live in `mobile/assets/android-icon-*.png`. Background colour is brand navy `#032488`.

## Signing and build

1. Play Console app + Play App Signing.
2. Let EAS generate an upload key, or supply your own. Store the keystore outside git (`.gitignore` already ignores `*.jks` / `*.keystore`-style files).
3. `npx eas-cli@latest build --platform android --profile production` from `mobile/`.
4. Upload the AAB to an **internal** track first, then closed, then production.

```bash
npx eas-cli@latest submit --platform android --profile production
```

## Play Console

The marketing and legal site is live at [https://www.subupapp.co.uk](https://www.subupapp.co.uk) (Vercel, separate repo `inteckltd/subup-website`). Paste:

- **Privacy Policy URL**: `https://www.subupapp.co.uk/privacy`
- Store listing website / support: `https://www.subupapp.co.uk/`
- Data safety form (same processors as iOS: Supabase, Twilio, Expo, Sentry)
- Short / full description, feature graphic (1024×500), phone screenshots
- Target API level as required by Play
- `INVITE_APP_URL` falls back to `https://www.subupapp.co.uk` when unset (`mobile/src/lib/env.ts` and the invite SMS function). An in-repo copy of the pages is in [`site/`](../site/).

Remaining store polish: [TEMP_CATEGORY_1_LAUNCH.md](TEMP_CATEGORY_1_LAUNCH.md).
