# Security

A stolen **publishable / anon key is expected** (it ships in the app). Defence is RLS, RPC grants, and Edge Function JWT checks. A stolen **session JWT** is a full account until the user signs out.

## What the client can do

- `anon` is revoked on domain tables. `is_email_taken` is granted to `anon` (boolean only) and is **rate-limited**.
- Game, membership, invite, and score **writes** go through `SECURITY DEFINER` RPCs (`search_path = public, pg_temp`). Direct INSERT/UPDATE/DELETE policies on `games`, `game_players`, `group_members`, and `group_invites` are dropped.
- `game_payments` has no client grants. `stripe_accounts` is own-row SELECT only. `payment_status = paid` is set only by the Stripe webhook (service role).
- `groups` keeps client INSERT (create group + trigger adds the admin). Updates go through `update_group`.
- Profile stats and `profiles.mobile` cannot be updated by the role `authenticated` (triggers). Mobile changes use `update-my-mobile` (OTP) or `confirm_my_mobile` after Auth OTP.
- Group-mates cannot `SELECT` another profile’s mobile or email. Rosters use `get_group_members` / `get_game_lobby_players`.
- Notifications have no client INSERT. Own-row SELECT / UPDATE / DELETE only.
- `group_join_links` has no client table grants. Admins read a token via `get_group_join_token`; anyone with the URL can `preview_group_join_link`; signed-in users join via `claim_group_join_link`.
- Storage writes are `{auth.uid()}/...`. Buckets are public-read (avatars / covers).
- Account deletion is `delete-my-account` (JWT + service role).

## Rate limits

| Action | Limit |
|--------|--------|
| `invite_group_member` | 20 / hour / user |
| `claim_group_join_link` | 30 / hour / user |
| `is_email_taken` | 10 / hour / IP (or `anon`) |
| `is_mobile_taken` | 20 / hour / user |
| Phone-change OTP | 3 / hour / user (Edge Function) |
| Auth sign-in / OTP | Supabase Dashboard defaults |

Invite SMS is **once per invite** (`group_invites.sms_sent_at`). Repeat POSTs to `notify-group-invite` do not re-text.

## Edge Functions

User-facing functions verify the JWT with the anon key, then use `service_role` only if the caller can see the row under RLS.

Cron functions (`apply-game-lock`, `close-motm-votes`, `send-score-reminders`, `send-lock-reminders`) have `verify_jwt = false` in `supabase/config.toml` and compare `x-cron-secret` in constant time. `stripe-webhooks` is also `verify_jwt = false` and checks the Stripe signature instead. Do not add more unverified functions.

CORS is `*` while the only client is native. Lock this down if you add a browser app.

## Phone identity

- Sign-up: Auth phone + password (Confirm phone **off**). One-time SMS OTP, then `confirm_my_mobile`. Pending invites attach only when `mobile_verified_at` is set.
- Change number: OTP to the **new** number via Twilio in `update-my-mobile`.
- Forgot password: `signInWithOtp` with `shouldCreateUser: false`; unknown numbers return success.

## Checklist on the live project

- [ ] Migrations through `026` applied
- [ ] Dashboard auth rate limits left on
- [ ] Confirm phone **off**
- [ ] Twilio not in trial for production SMS
- [ ] `CRON_SECRET` + Vault URLs set
- [ ] No extra `verify_jwt = false` functions beyond cron + `stripe-webhooks`
- [ ] Service role key never in the mobile app or git
