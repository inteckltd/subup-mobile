# iOS App Store

Bundle ID: `com.inteck.subup` (`mobile/app.json`). Encryption export: `ITSAppUsesNonExemptEncryption = false`.

## Certificates and build

1. Apple Developer account, App ID, push capability if you use production push.
2. `npx eas-cli@latest build --platform ios --profile production` from `mobile/`.
3. `npx eas-cli@latest submit --platform ios --profile production` once `eas.json` `submit.production` has ASC credentials (or use the interactive submit).

## App Store Connect

Hosted copy lives in [`site/`](../site/). Until the marketing site exists, publish that folder (see [`site/README.md`](../site/README.md)) and paste:

- **Support URL** / Marketing URL: `https://YOUR-HOST/` (`index.html`)
- **Privacy Policy URL**: `https://YOUR-HOST/privacy.html`
- Terms of Use (optional): `https://YOUR-HOST/terms.html`

Stores reject in-app-only legal copy.

- Subtitle, description, keywords
- Screenshots: 6.7" and 6.5" iPhone (and iPad if you keep `supportsTablet`)
- Age rating / no kids-directed content
- Privacy Nutrition Labels aligned with [legal copy](../mobile/src/features/legal/copy.tsx) and [SECURITY.md](SECURITY.md) (mobile, optional email, photos, diagnostics, Twilio, Supabase, Expo, Sentry)
- Review notes + demo account (see ignored `supabase/seed_app_review_user.sql` — do not run on production casually)

Account deletion is already in Settings (Apple 5.1.1(v)).

Remaining store polish: [TEMP_CATEGORY_1_LAUNCH.md](TEMP_CATEGORY_1_LAUNCH.md).
