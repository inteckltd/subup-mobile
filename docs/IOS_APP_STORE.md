# iOS App Store

Bundle ID: `com.inteck.pitchin` (`mobile/app.json`). Encryption export: `ITSAppUsesNonExemptEncryption = false`.

## Certificates and build

1. Apple Developer account, App ID, push capability if you use production push.
2. `npx eas-cli@latest build --platform ios --profile production` from `mobile/`.
3. `npx eas-cli@latest submit --platform ios --profile production` once `eas.json` `submit.production` has ASC credentials (or use the interactive submit).

## App Store Connect

- Privacy Policy **https URL** (stores reject in-app-only copy)
- Support URL
- Subtitle, description, keywords
- Screenshots: 6.7" and 6.5" iPhone (and iPad if you keep `supportsTablet`)
- Age rating / no kids-directed content
- Privacy Nutrition Labels aligned with [legal copy](../mobile/src/features/legal/copy.tsx) and [SECURITY.md](SECURITY.md) (mobile, optional email, photos, diagnostics, Twilio, Supabase, Expo, Sentry)
- Review notes + demo account (see ignored `supabase/seed_app_review_user.sql` — do not run on production casually)

Account deletion is already in Settings (Apple 5.1.1(v)).

Remaining store polish: [TEMP_CATEGORY_1_LAUNCH.md](TEMP_CATEGORY_1_LAUNCH.md).
