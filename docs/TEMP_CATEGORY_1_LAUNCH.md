# Category 1 — required before public launch

Temporary list of work that is **still required** after the security / simplicity / docs pass. Not scheduled in a sprint here — track these before App Store + Play Store.

## Money

- [x] Stripe Connect + pay-to-join (no cash / waive). Code is in; sandbox keys + webhook still needed.
- [x] Apply migrations `023`–`026` on the hosted project
- [x] `supabase secrets set` `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- [x] `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` in mobile `.env` and EAS
- [x] Deploy Edge Functions: `create-connect-account-link`, `create-join-payment`, `leave-paid-game`, `refund-game-payments`, `stripe-webhooks`, `stripe-connect-redirect`
- [x] Stripe Dashboard: Connect Express (UK), webhook to `/functions/v1/stripe-webhooks` (`payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `account.updated`)
- [x] Apple Pay merchant ID `merchant.com.inteck.pitchin` in Apple Developer + Stripe (test cards work without this)
- [ ] Rebuild a **dev client** (`expo-dev-client`) — Stripe native SDK will not run in Expo Go

## Legal and trust

- [ ] Solicitor review of in-app Terms + Privacy (`mobile/src/features/legal/copy.tsx` is a complete **draft**)
- [ ] Hosted **https** Terms and Privacy URLs for both stores
- [ ] Bump `TERMS_VERSION` / `PRIVACY_VERSION` after the lawyer text lands
- [ ] Apple Privacy Nutrition + Google Data safety aligned with the policy

## Brand and store

- [ ] Final logo and iOS icon (current icon is still a construction-grid mark)
- [ ] Final Android adaptive foreground
- [ ] Store screenshots (iPhone 6.7" / 6.5"; Play phone) + feature graphic
- [ ] Subtitle, keywords, support URL, marketing / landing page
- [ ] `INVITE_APP_URL` pointing at TestFlight / Play / landing
- [ ] App Review + Play demo account (do not casually seed production)

## Ops

- [-] Production Twilio (not trial)
- [ ] EAS production secrets + `eas submit` credentials for both platforms
- [-] Cron Vault secrets on the production Supabase project
- [-] Confirm migrations through `022` on the hosted project
- [ ] Watch Sentry source-map upload (`SENTRY_ALLOW_FAILURE` is still true)

See [IOS_APP_STORE.md](IOS_APP_STORE.md) and [ANDROID_PLAY_STORE.md](ANDROID_PLAY_STORE.md).
