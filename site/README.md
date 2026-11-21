# SubUp legal / support site

The public site is already live:

| Store field | Live URL |
| --- | --- |
| **Support URL** / Marketing URL | https://www.subupapp.co.uk/ |
| **Privacy Policy URL** | https://www.subupapp.co.uk/privacy |
| Terms of Use | https://www.subupapp.co.uk/terms |

That site is hosted on Vercel from the separate repo `inteckltd/subup-website`. It is not published from this folder.

This `site/` folder is the copy that sits next to the app. In-app versions in `mobile/src/features/auth/schemas.ts` are **Terms 1.7** and **Privacy 1.5**. When these notes were written, the public pages showed Terms 1.6 (dated 26 August 2026) and Privacy 1.5 (dated 3 November 2026). Do not assume the two copies match word for word. Solicitor review is still an open item in [TEMP_CATEGORY_1_LAUNCH.md](../docs/TEMP_CATEGORY_1_LAUNCH.md).

`INVITE_APP_URL` (Edge Function) and `EXPO_PUBLIC_INVITE_APP_URL` (app) both fall back to `https://www.subupapp.co.uk` when unset.

## GitHub Pages workflow

`.github/workflows/pages.yml` (“Deploy legal site”) is still in this repo. It is set up to publish this `site/` folder to GitHub Pages. It is not how the live site is published (that is Vercel). Actions history shows two runs, both failures, the later one on 9 September 2026. The workflow was left in place on purpose.

## Old Netlify shortcut

Netlify Drop was an early way to get an https URL before the marketing site existed. Use the Vercel URLs above in App Store Connect and Play Console.
