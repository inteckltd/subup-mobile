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

### Guideline 2.1 — Apple Pay / PassKit

The binary includes PassKit because `@stripe/stripe-react-native` links `StripeApplePay`. The app **does** use Apple Pay: Stripe Payment Sheet, opened when a player joins a **paid** game. Merchant ID: `merchant.com.inteck.pitchin`.

Apple cannot find it on the review login if the only seeded game is free (or the reviewer is already joined). Paste this into Review Notes on every submission, and reply with the same text if App Review asks:

```
Login is UK mobile + password (not email). Username 07700900000, password PitchInReview2026!. Type the number in Phone number. Do not request an SMS code — the account is already verified.

Apple Pay: used via Stripe Payment Sheet when joining a paid game. Not a standalone Wallet or Settings screen. Merchant ID merchant.com.inteck.pitchin.

After sign-in: open group “Review Kickabout” → open paid game “Paid review kickabout” → tap “Pay £… to join”. The sheet offers Apple Pay and card. PassKit is from the Stripe iOS SDK; we do use it.
```

Before submitting, the review user must have Stripe Connect charges + transfers enabled (Group → Payouts), then re-run `seed_app_review_user.sql` so the paid game exists and the reviewer is **not** already a player on it.

Account deletion is already in Settings (Apple 5.1.1(v)).

Remaining store polish: [TEMP_CATEGORY_1_LAUNCH.md](TEMP_CATEGORY_1_LAUNCH.md).
