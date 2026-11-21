# Category 2 — nice to haves / future features

Do not put these on the v1 critical path. Complexity will kill usage.

## Auth (from AUTH_BACKLOG)

Sign-up and login stay **mobile + password**. Forgot password and one-time mobile confirm are SMS OTP. None of the items below are scheduled.

### SMS OTP on every login

The original helpers were deleted. Rebuild a `/verify` screen if this becomes the login model — do not revive the old Express `/api`. Confirm phone on sign-up must stay **off**.

### Apple / Google sign-in

Rebuild social buttons and a complete-mobile step for users with no UK number. If you offer any third-party login, Apple requires Sign in with Apple. Needs Google client IDs and Apple capability.

### Face ID / Touch ID

Gate unlocking the stored session (`LargeSecureStore`) with `expo-local-authentication`. Independent of SMS.

### Email verification

Email can be entered at sign-up but is never confirmed.

### Pre-auth hardening

Forgot-password uses Supabase Auth `signInWithOtp` (Dashboard rate limits). If a custom pre-auth Edge Function is added later, restrict it (App Attestation / Play Integrity), not an open URL.

## Product

- Recurring games
- Announcements / light chat
- Reliability (show-up %) in the UI (`reliability_score` exists on profiles)
- Per-sport MMR (a rating that is not tied to one group). Per-group MMR shipped in 1.0.4 (`037_group_mmr_and_join_questions.sql`): each membership has its own rating.

## Engineering

The marketing site is live at https://www.subupapp.co.uk (Vercel, repo `inteckltd/subup-website`). `INVITE_APP_URL` falls back to that URL.

- App Attestation / Play Integrity on sensitive Edge Functions
- Separate `CRON_SECRET` per cron function
- Dark mode
- Extract shared `friendlyError`
- Broader automated tests beyond CI lint + `tsc`
- Comment cleanup of dead `PLAN.md` / `PLAN_PHASE2.md` references

The canonical product roadmap is [PRODUCT.md](PRODUCT.md). Auth notes also lived in [AUTH_BACKLOG.md](AUTH_BACKLOG.md); keep that file as a pointer here.
