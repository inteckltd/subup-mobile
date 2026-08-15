# PitchIn

> Organise recreational sports with your mates — without WhatsApp chaos.

## What it is

PitchIn is a mobile app (iOS & Android) for friend groups who play sports together
(football, rugby, padel, basketball, etc.). It replaces messy group chats with
structured **groups**, **games**, **payments**, **scores**, and a lightweight
**MMR rating** (inspired by apps like Playtomic), plus **Man of the Match**.

**Working name:** PitchIn  
**Platforms:** iOS and Android via **Expo (React Native)**  
**Backend:** **Supabase** (Auth, Postgres, RLS, Edge Functions, Storage later)  
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
5. Players join and pay (card) or are marked **pay cash** by admin
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

- **Primary identifier:** UK mobile number
- **Login:** Mobile + password → **SMS OTP every time** (2-step) → session
- **Email:** Optional; captured for receipts/comms later — **not** used to log in
- **Sign up:** Name, UK mobile, password, optional email, accept Terms + Privacy → SMS OTP verify
- **Forgot password:** Phase 1 (reset via mobile OTP + new password flow)
- **Social:** Sign in with **Apple** and **Google** (link/create profile; still collect UK mobile if missing before main app features)
- **No age gate** in v1
- **No SMS OTP to email** — OTP is **mobile SMS only**

## Feature modules (roadmap)

### Phase 1 — Auth (current)
- Sign up, Verify (SMS OTP), Login (password + SMS OTP)
- Forgot password
- Apple + Google sign-in
- Session persistence, auth gate, placeholder home
- `profiles` table + RLS
- Terms + Privacy acceptance recorded

### Phase 2 — Groups & members
- Create group (name, sport, venue defaults, description, cover)
- Invite by mobile (and email if present)
- Accept / decline invite
- Members list, roles, promote admin
- Basic group detail screen

### Phase 3 — Games & lobby
- Create game (schedule, venue, min/max, cost, notes, cash allowed)
- Join / leave, max cap, lobby player list
- Payment status chips (Paid, Cash, Unpaid)
- Auto-cancel job if min not met at T-24h

### Phase 4 — Payments
- In-app card pay (e.g. Stripe) to organiser
- Admin marks cash / waived / refund
- Cancel/refund rules

### Phase 5 — Results & MMR
- Admin enters score
- MOTM voting
- MMR calculation (start rating, win/draw/loss, MOTM bump)
- Game history + player stats

### Phase 6+ (later)
- Waitlist, recurring games, team balance helper
- Announcements / light chat
- Reliability (show-up %)
- Push notifications
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

- Expo (managed) + React Native + TypeScript
- Expo Router
- NativeWind
- Supabase: Auth, Postgres, RLS, Edge Functions
- Forms: react-hook-form + zod
- Secure session storage (expo-secure-store)
- SMS via Supabase phone auth provider (e.g. Twilio)
- Social: Apple + Google → Supabase

## Supabase project

- Create in region **eu-west-2 (London)** when ready
- Never commit service role keys
- Client uses anon key only; privileged ops in Edge Functions

## What not to build until the right phase

- Do not skip RLS
- Do not use WhatsApp as a backend
- Do not make groups public by default
- Do not implement payments/MMR in Phase 1

## Pitch (one liner)

**PitchIn** — organise the kickabout, collect the cash, track the games, climb the ratings.