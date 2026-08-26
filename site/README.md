# SubUp legal / support site

Static pages for App Store Connect and Play Console:

| Store field | File | Path once live |
| --- | --- | --- |
| **Support URL** / Marketing URL / Hosted URL | `index.html` | `/` |
| **Privacy Policy URL** | `privacy.html` | `/privacy.html` |
| Terms of Use (optional but useful) | `terms.html` | `/terms.html` |

Copy matches in-app draft versions **Terms 1.4** and **Privacy 1.3**. Still needs solicitor review before public launch.

## Fastest host (about a minute)

1. Open [app.netlify.com/drop](https://app.netlify.com/drop) (free account).
2. Drag this `site` folder onto the page.
3. You get an `https://….netlify.app` URL. Paste that into both stores:
   - Support / hosted URL → `https://YOUR-SITE.netlify.app`
   - Privacy → `https://YOUR-SITE.netlify.app/privacy.html`
   - Terms → `https://YOUR-SITE.netlify.app/terms.html`

Rename the site in Netlify if you want something like `subup.netlify.app`. Point a custom domain at it later when the marketing site is ready.

## Stay in this repo (GitHub Pages)

After these files are on `main`:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. The `Deploy legal site` workflow publishes this folder.

Public URL will be `https://inteckltd.github.io/pitchin/` if the repo stays private-with-Pages or is public. If Pages from a private repo is blocked on the org plan, use Netlify Drop instead.
