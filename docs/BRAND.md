# SubUp brand brief

For marketing, a designer, or an agency. This is what the **live app** uses today. Please match these values so the logo, store listings, and ads sit on the same product.

**Working name:** SubUp  
**Spoken:** “Sub Up”  
**Written:** SubUp (one word, capital S and U). Not Sub-Up, Subup, or SUBUP in body copy.  
**One-liner:** Organise the kickabout, collect the cash, track the games, climb the ratings.  
**Company / legal:** Inteck (`com.inteck.subup`)  
**Market:** United Kingdom first. Copy uses UK English: mobile, mates, pitch, venue.

---

## What it is

Private sports groups for friends (football, rugby, padel, basketball, etc.). Not a public court marketplace. It replaces WhatsApp chaos: who’s playing, lock the squad, scores, Man of the Match, a simple rating.

**Feel:** clean, sporty, trustworthy. Playtomic-like clarity. Not enterprise, not lads-mag, not neon gaming.

**Personality:** straight, warm, brief. Like a good captain’s message — not a corporate newsletter.

---

## Voice

| Do | Don’t |
|----|--------|
| “Invite your mates” | “Onboard your users” |
| “Pitch”, “venue”, “mobile” | “Field”, “cell phone”, “soccer” (unless the group’s sport is soccer) |
| Short buttons: Join, Leave, Confirm | Clever puns on every screen |
| Confident and calm | Hype, all-caps slogans, emoji walls |

App wordmark in the header is **SUBUP** in extra-bold uppercase. Marketing headlines can be sentence case; the in-app mark stays tight and uppercase.

---

## Colours (source of truth)

From `mobile/src/theme/tokens.ts`. Do not invent a second palette.

| Token | Hex | Use |
|-------|-----|-----|
| **Primary** | `#032488` | Navy. Headers, primary buttons, brand field, Android adaptive icon background |
| **Accent** | `#05deed` | Cyan. Logo, highlights, FAB, avatar ring. Use sparingly |
| **Ink** | `#010101` | Body text |
| **Muted** | `#5C6B8A` | Subtitles, hints |
| **Background** | `#FEFEFD` | App canvas, splash background |
| **White** | `#FFFFFF` | Cards |
| **Border** | `#F3F4F6` | Hairline dividers |
| **Danger** | `#DC2626` | Errors, leave, delete only |
| **Gold** | `#F2C14E` | MMR chip only. Not for logos |

**Pairs that already work in the app**

- Navy field + cyan lockup (home header)
- Off-white canvas + white cards + navy buttons
- Cyan FAB on navy/ink

**Contrast:** cyan `#05deed` on white is weak. Put cyan on navy (`#032488`), or navy on cyan. Never cyan text on the off-white canvas.

---

## Type

- **Family:** [Manrope](https://fonts.google.com/specimen/Manrope) (Google Fonts)
- Weights in use: 400 regular, 500 medium, 700 bold, 800 extra-bold
- UI is sans, slightly geometric. Extra-bold + tight tracking for the wordmark
- Do not pair with a second display face unless marketing needs it for a poster; keep Manrope for anything that sits next to screenshots

---

## Shape and layout

- Cards: large radius (~40pt) — the navy header is a rounded-bottom “hero”
- Controls / inputs: 16pt radius
- Pills / chips: 12pt
- Screen padding: 24pt
- Light mode only for now
- Lots of white space. One primary action per screen

---

## Logo — what we need from you

The header lockup is in `mobile/assets/images/subup-logo.png` (cyan on transparent). The store icon is the navy field with the cyan squad mark (`mobile/assets/icon.png`). It is not the old Expo construction-grid placeholder. The same mark is the Android adaptive foreground and the splash symbol.

**Still useful outside the app binary**

1. **App icon** — already in the app (`mobile/assets/icon.png`). A 1024×1024 master with no rounded-rect baked in is what iOS masks.
2. **Android adaptive icon** — already in the app. Foreground on transparent, safe zone in the centre ~66%. Background is flat `#032488`.
3. **Symbol only** — the splash and monochrome assets are the mark. A small notification (24pt) and favicon export may still be wanted for marketing.
4. **On navy** and **on cyan** and **on `#FEFEFD`** versions (full colour + single-colour), if marketing needs files the app does not ship.
5. **Splash** — symbol centred on `#FEFEFD` is already `mobile/assets/splash-icon.png`.
6. **Store** — 1024×500 Play feature graphic; iPhone 6.7" / 6.5" screenshot frames. Not in this repo.

**Direction (not a brief to copy blindly)**

- Private squad, not a stadium brand
- Cyan is the spark; navy is the field
- Avoid clip-art balls, trophy piles, or WhatsApp-green clones (`#25D366`)
- The old Expo construction-grid mark is gone from `mobile/assets/icon.png`. Do not bring it back.

**File formats:** SVG + PDF for print/web; PNG @1x/2x/3x for the app. No drop shadows that break at small sizes.

---

## Photography

Auth screens use warm, real-sport stills (`mobile/assets/images/auth-hero.jpg`). Prefer real 5-a-side / park pitches, UK light, mixed groups. Avoid stock “business handshake on a football”.

---

## Assets already in the repo

| File | Notes |
|------|--------|
| `mobile/assets/images/subup-logo.png` | Header / auth lockup (cyan, transparent) |
| `mobile/assets/icon.png` | Store icon: navy field, cyan squad mark |
| `mobile/assets/splash-icon.png` | Same mark, navy on `#FEFEFD` |
| `mobile/assets/android-icon-*.png` | Adaptive layers; background `#032488`, foreground and monochrome are the squad mark |
| `mobile/src/theme/tokens.ts` | Colours the code actually uses |

---

## Legal / store names

- **Display name:** SubUp  
- **iOS / Android id:** `com.inteck.subup`  
- Expo project slug remains `pitchin` (internal; not shown on the stores)
