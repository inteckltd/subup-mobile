# Auth backlog — deferred

Sign-up and login are **mobile + password only**. SMS OTP, forgot-password, and Apple/Google sign-in were removed from the codebase (not mothballed). Restoring them means **rebuilding from git history**, not uncommenting.

None of this is scheduled.

## Restore SMS OTP login (2-step mobile + OTP)

Blocked on a Twilio/SMS provider. The original helpers (`OtpInput`, `useCountdown`, `complete-mobile.tsx`) were deleted. Rebuild a `/verify` screen and an Edge Function for any pre-auth throttling — do not revive the old Express `/api`.

## Restore forgot password

Same SMS blocker. Email reset is the realistic path while SMS is down (email is already optional at sign-up).

## Restore Apple / Google social sign-in

Rebuild `useSocialSignIn`, social buttons, and a complete-mobile step for users with no UK number. Needs Google iOS/Android/Web client IDs and Apple Sign In capability.

## Sign in with Face ID / Touch ID

Gate unlocking the already-stored session (`LargeSecureStore`) with `expo-local-authentication`. Independent of SMS.

## Email verification

Email can be entered at sign-up but is never confirmed.

## Legal copy

Terms and Privacy are still placeholder text. Versioning and re-consent **are** implemented: bump `TERMS_VERSION` / `PRIVACY_VERSION` in `mobile/src/features/auth/schemas.ts` and existing users must accept again.

## Pre-auth endpoint hardening

If a future OTP or reset Edge Function is added, restrict it (App Attestation / Play Integrity, not an open URL).
