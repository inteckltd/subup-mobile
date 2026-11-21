# Category 1 — leftover launch work

The app is on the stores. `mobile/app.json` version is **1.0.6**. Store links in the app are the App Store listing `id6805179101` and Play listing `com.inteck.subup` (`mobile/src/lib/storeUrls.ts`).

This list is what was still open after the security / simplicity / docs pass. Checked items are done from this repo (or were already checked). Anything this repo does not show stays open.

## Money

- [x] Stripe Connect + pay-to-join (no cash / waive). Code is in; sandbox keys + webhook still needed.
- [x] Apply migrations `023`–`026` on the hosted project
- [x] Migrations in this repo now run through `040` (`supabase/migrations/`). `037` is per-group MMR and join questions (shipped in 1.0.4). `038` is the rating K window and a 12-hour lock option. `039` and `040` are hold-then-capture and are not applied to any hosted project yet.
- [ ] Confirm the hosted project has every migration through `038` (this repo cannot see that database)
- [ ] Apply `039` then `040` only after the hold-then-capture test plan. Do not apply them as part of the `038` catch-up.
- [x] `supabase secrets set` `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- [x] `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` in mobile `.env` and EAS
- [x] Deploy Edge Functions: `create-connect-account-link`, `create-join-payment`, `leave-paid-game`, `refund-game-payments`, `stripe-webhooks`, `stripe-connect-redirect`
- [x] Stripe Dashboard: Connect Express (UK), webhook to `/functions/v1/stripe-webhooks`. Events: `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`, `payment_intent.canceled`, `setup_intent.succeeded`, `charge.refunded`, `account.updated`. Add the two new events (`amount_capturable_updated`, `setup_intent.succeeded`) in the Dashboard before relying on holds. Do this in test mode first.
- [x] Apple Pay merchant ID `merchant.com.inteck.pitchin` in Apple Developer + Stripe (test cards work without this)
- [ ] Rebuild a **dev client** (`expo-dev-client`) — Stripe native SDK will not run in Expo Go

## Legal and trust

- [ ] Solicitor review of in-app Terms + Privacy (`mobile/src/features/legal/copy.tsx`). In-app versions in `mobile/src/features/auth/schemas.ts` are Terms **1.8** and Privacy **1.6** (hold-then-capture re-consent). The public site (below) showed Terms 1.6 and Privacy 1.5 when these notes were written.
- [x] Legal and marketing pages are live at **https://www.subupapp.co.uk** (Vercel, separate repo `inteckltd/subup-website`). Privacy: `/privacy`. Terms: `/terms`. This repo’s `site/` folder is a copy only. The GitHub Pages workflow (`.github/workflows/pages.yml`, “Deploy legal site”) is still in the repo and is not the live host. Its two Actions runs both failed; the later one was 9 September 2026.
- [ ] Bump `TERMS_VERSION` / `PRIVACY_VERSION` after the lawyer text lands
- [ ] Apple Privacy Nutrition + Google Data safety aligned with the policy

## Brand and store

- [x] iOS app icon and Android adaptive icon are the navy / cyan squad mark in `mobile/assets/icon.png` and `mobile/assets/android-icon-*.png` (not the Expo construction-grid placeholder). Splash uses the same mark.
- [ ] Wider logo pack still not in the repo: SVG/PDF, extra colourways, Play feature graphic (1024×500)
- [ ] Store screenshots (iPhone 6.7" / 6.5"; Play phone)
- [ ] Subtitle and keywords
- [x] Support URL and marketing site: https://www.subupapp.co.uk
- [x] `INVITE_APP_URL` falls back to https://www.subupapp.co.uk (`mobile/src/lib/env.ts`, invite SMS)
- [x] App Review demo login is kept privately by the owner (not in this repo). Do not commit it, and do not casually seed production.

## Ops

- [-] Production Twilio (not trial)
- [ ] EAS production secrets + `eas submit` credentials for both platforms (not visible in this repo). The repo version is 1.0.6 and the app shares store URLs; that does not prove the EAS project settings.
- [-] Cron Vault secrets on the production Supabase project
- [x] Repo migrations are `001`–`038` (the old “through `022`” note is out of date). Hosted apply is the open confirm above.
- [ ] Watch Sentry source-map upload (`SENTRY_ALLOW_FAILURE` is still true)

See [IOS_APP_STORE.md](IOS_APP_STORE.md) and [ANDROID_PLAY_STORE.md](ANDROID_PLAY_STORE.md).
