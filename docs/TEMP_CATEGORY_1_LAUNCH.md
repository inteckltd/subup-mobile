# Category 1 — required before public launch

Temporary list of work that is **still required** after the security / simplicity / docs pass. Not scheduled in a sprint here — track these before App Store + Play Store.

## Money

- [ ] Stripe: card pay on join, admin mark cash / waived, auto-cancel refunds
- [ ] Decide **platform account vs Stripe Connect** (who receives pitch fees)
- [ ] UK SCA / 3DS, webhook signature verification, no client-set `payment_status = paid`
- [ ] Turn payment chips / cash toggle back on only when the above is live

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

- [ ] Production Twilio (not trial)
- [ ] EAS production secrets + `eas submit` credentials for both platforms
- [ ] Cron Vault secrets on the production Supabase project
- [ ] Confirm migrations through `022` on the hosted project
- [ ] Watch Sentry source-map upload (`SENTRY_ALLOW_FAILURE` is still true)

See [IOS_APP_STORE.md](IOS_APP_STORE.md) and [ANDROID_PLAY_STORE.md](ANDROID_PLAY_STORE.md).
