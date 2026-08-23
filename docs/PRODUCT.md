# PitchIn

> Organise recreational sports with your mates — without WhatsApp chaos.

## What it is

PitchIn is a mobile app (iOS & Android) for friend groups who play sports together
(football, rugby, padel, basketball, etc.). It replaces messy group chats with
structured **groups**, **games**, **payments**, **scores**, and a lightweight
**MMR rating** (inspired by apps like Playtomic), plus **Man of the Match**.

**Working name:** PitchIn  
**Platforms:** iOS and Android via **Expo (React Native)**  
**Backend:** **Supabase** (Auth, Postgres, RLS, Storage, Edge Functions)  
**UI:** **NativeWind** + Expo Router  
**Primary market:** United Kingdom (UK phone numbers only for now)

## Problem

WhatsApp groups fail at:
- Who is actually playing?
- Who has paid?
- Ghost games when too few people show
- No history of scores or standout players
- No simple skill/form signal

## Solution — core loop

1. Sign up / log in (UK mobile)
2. Create or join **invite-only groups** (e.g. "Woolston 7:30pm Football")
3. Admins invite by mobile (or email if provided), promote other admins
4. Admins create **games** (date/time, venue, min/max players, cost, notes)
5. Players join and pay (Apple Pay / Google Pay / card). No pay = not in the game. Free (£0) games skip Stripe.
6. Enforce **max players**; if **min players** not met **24 hours before** → auto-cancel + refund card payments
7. After the game, admin enters **score**
8. Players vote **Man of the Match**
9. **MMR** updates on win/draw/loss (opposition strength matters); MOTM gets a small extra bump
10. Everyone can see **history**: who played, score, MOTM

## Differentiator

Not a public court marketplace. **Private groups + reliability + money + ratings.**
Simple enough for weekly 5-a-sides; structured enough to replace the admin spreadsheet.

---

## Auth model (important)

> **Currently:** sign-up/login are mobile + password. New accounts confirm the
> mobile once via SMS OTP. Forgot password also uses SMS OTP. Apple/Google
> sign-in and OTP-on-every-login are not in the app — see
> `docs/TEMP_CATEGORY_2_FUTURE.md`.

- **Primary identifier:** UK mobile number
- **Login (now):** Mobile + password → session
- **Login (target):** Mobile + password → **SMS OTP every time** (2-step) → session
- **Email:** Optional; captured for receipts/comms later — **not** used to log in
- **Sign up:** Name, UK mobile, password, optional email, accept Terms + Privacy, then one-time SMS confirm. Versions are stored on the profile; bumping `TERMS_VERSION` / `PRIVACY_VERSION` re-prompts existing users.
- **Forgot password:** Mobile OTP via Twilio, then set a new password
- **Social:** Not built (target: Apple + Google, still collect UK mobile if missing)
- **Account deletion:** Settings → Delete account (required by Apple)
- **No age gate** in v1

## Feature modules (roadmap)

### Phase 1 — Auth
**Built.** Sign up, login, session, profiles, one-time mobile confirm, forgot-password SMS OTP, Terms/Privacy with versioned re-consent, account deletion.

### Phase 2 — Groups & members
**Built.** Create/edit group (including sport), invite by mobile (existing users get push; new numbers get an SMS download link), accept/decline, members, promote/kick, last-admin protection.

### Phase 3 — Games & lobby
**Built.** Create/edit/cancel game, join/leave/waitlist, lock window, auto-cancel if min not met, MMR-balanced team pick.

### Phase 4 — Payments
**Built.** Stripe Connect Express (one treasurer per group), pay-to-join with Apple Pay / Google Pay / card, PitchIn fee on top of pitch cost, refunds on leave (before lock) and cancel / auto-cancel. No cash or waive. See `docs/TEMP_CATEGORY_1_LAUNCH.md` for remaining Stripe ops (webhook URL, live keys).

### Phase 5 — Results & MMR
**Built.** Admin score entry, MOTM voting, Elo-style MMR + MOTM bump, history and profile stats.

### Phase 6+ (later)
- Recurring games, announcements / light chat
- Reliability (show-up %)
- Per-sport or per-group MMR

## Domain concepts

| Concept | Meaning |
|--------|---------|
| Profile | User: name, UK mobile, optional email, avatar, MMR, stats |
| Group | Invite-only community for a regular sport meetup |
| Admin | Group creator or promoted member; manages invites, games, scores |
| Game | A single scheduled session inside a group |
| Lobby | Players who joined a game + payment state |
| MMR | Matchmaking rating; moves after results |
| MOTM | Man of the Match; peer vote after game |

## Design tone

- Clean, sporty, trustworthy (Playtomic-like clarity)
- Not enterprise/cluttered
- Brand colours (guidance): deep green `#0B6E4F`, lime accent `#B8F236`, charcoal `#121212`, soft bg `#F4F6F5`
- NativeWind, light mode first
- UK copy (e.g. "mobile", "mates", pitch/venue language)

## Tech stack (locked)

- Expo (managed) + React Native + TypeScript (`/mobile`)
- Expo Router
- NativeWind
- Supabase: Auth, Postgres, RLS, Storage, Edge Functions
- Forms: react-hook-form + zod
- Secure session storage (expo-secure-store)
- Push: expo-notifications + Expo Push API
- Errors: Sentry (`@sentry/react-native` + Edge Function reporting)

## Supabase project

- Create in region **eu-west-2 (London)** when ready
- Never commit service role / secret keys
- Client uses the publishable (anon-equivalent) key only; privileged ops live in Edge Functions

## What not to build until the right phase

- Do not skip RLS
- Do not use WhatsApp as a backend
- Do not make groups public by default
- Do not ship store builds with placeholder legal URLs — Phase 4 ops in `TEMP_CATEGORY_1_LAUNCH.md` must be live first

## Pitch (one liner)

**PitchIn** — organise the kickabout, collect the cash, track the games, climb the ratings.