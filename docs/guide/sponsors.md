# Support (Sponsors & Partners)

BagIdea Office is open-source and free to use. Support funds development, art
licensing, and cross-platform backends — and keeps the program free. Sponsors'
names/logos appear on the [official website](https://bagidea.com/#sponsors) and
in the repo's README.

> **Quick overview:** support is **entirely a monthly membership through GitHub
> Sponsors** (like a YouTube / Patreon membership) — payments, taxes, and payouts
> are GitHub's responsibility, not ours. We just pull "name + logo + link" and
> display them automatically.

## Tiers (by monthly amount)

| Tier | Per month | What you get |
|---|---|---|
| 👑 **Gold Partner** | $3,000+ | Large logo in the top spot (website + README + in-app credits) · help shape the roadmap · thanked in release notes |
| 🥈 **Silver Partner** | $300+ | Logo on the website + README · mentioned in release notes · early access to builds |
| 🥉 **Bronze / Backer** | $30+ | Logo or name + link on the sponsor wall |
| 💛 **Supporter** | Any amount | Name + link on the sponsor wall |

Every tier always gets a **clickable link to its own website/social** · sorted
automatically from highest amount to lowest · **no amounts are shown** anywhere.

## Steps for those who want to sponsor

1. **Pick a tier and sponsor** — click the **💖 Sponsor on GitHub** button on the
   website (or go to [github.com/sponsors/bagidea](https://github.com/sponsors/bagidea)
   directly), choose a monthly tier, and confirm. GitHub charges every month until
   you cancel.
2. **Logo and link are pulled from your GitHub profile automatically** — a
   sponsor's avatar, name, and link come straight from their own GitHub account,
   **you don't need to send us anything**.
   - Want a custom link? → set the **Website** field in your GitHub profile (*Settings → Public profile*)
   - A company? → sponsor as a **GitHub Organization** to get the org logo + company website
3. **Your name appears within ~6 hours** — just choose **"Make my sponsorship public"**
   when you pay, and the automation adds your name to the sponsor wall on the
   website + README for you (anyone set to Private won't be shown, respecting privacy).

## How the system works behind the scenes

```
Someone clicks Sponsor (website / repo / profile)
   → GitHub Sponsors charges monthly
   → GitHub Action (.github/workflows/sponsors.yml) runs every 6 hrs
   → pulls the public list via the GitHub Sponsors GraphQL API
   → sorts into tiers by amount + merges with off-platform names
   → writes web/sponsors.json + the block in README
   → GitHub Pages redeploys → appears on the wall on the website + README
```

Related files:

| File | Role |
|---|---|
| `web/sponsors.json` | **(generated — do not edit by hand)** the data the website renders |
| `web/sponsors.manual.json` | **editable by hand** — off-platform sponsors (partner / direct transfer) |
| `web/assets/sponsors.js` | renders the wall on the website (logo → name → avatar-chip per tier) |
| `scripts/sync-sponsors.mjs` | pulls from GitHub Sponsors + merges + writes the files |
| `.github/workflows/sponsors.yml` | runs the sync every 6 hrs + can be triggered manually + commits on change |
| `.github/FUNDING.yml` | the 💖 Sponsor button on the repo page |

## Off-platform sponsors (the exception)

Normally **everyone sponsors through GitHub Sponsors** so the automation works
fully. The exceptions are:

- **WARRIX** — the main partner, listed by hand in `web/sponsors.manual.json` and **always pinned at #1**
- **Reuannamphung** — paid directly first, shown temporarily **until they move to GitHub Sponsors**

How to add/edit off-platform sponsors (for maintainers):

1. Download the logo and store it in `web/img/sponsors/` (**don't hotlink a URL from a CDN/Facebook** — it expires)
2. Add an object to `web/sponsors.manual.json`:
   ```json
   { "name": "Name", "tier": "supporter", "weight": 5,
     "url": "https://example.com", "logo": "img/sponsors/file.png", "since": "2026-06" }
   ```
   - `weight` = a number used only for sorting (not shown); use any value
   - the sync will merge it in without overwriting GitHub sponsors

> ⚠️ **Don't edit `web/sponsors.json` by hand** — it gets regenerated and overwritten
> on every sync. Edit `web/sponsors.manual.json` only, for off-platform names.

## One-time setup (for maintainers)

1. Open GitHub Sponsors at [github.com/sponsors](https://github.com/sponsors) → create
   monthly tiers at **$5 / $30 / $300 / $3,000** → **Publish** every tier
2. Create a **classic PAT** for the account (scopes **`read:user` + `read:org`** — you
   need both, because a sponsor might be an Organization) → add it as a repo secret named **`SPONSORS_TOKEN`**
3. Run the **"Sync sponsors"** workflow once in the Actions tab to test it
