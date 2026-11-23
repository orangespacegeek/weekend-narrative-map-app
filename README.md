# Weekend Event Narrative Map

Phone-first tool for running a one-weekend Horus Heresy narrative tournament. Visitors open the node-and-route map and the result board. The event admin signs in to edit the map and to record results. Players do not have accounts.

This app was imported from [HH-Map-Campaign-Interface](https://github.com/orangespacegeek/HH-Map-Campaign-Interface) and stripped down to the pieces a weekend event still needs. The campaign rules, player roster, and turn structure are gone.

## What is here

- `server.js` serves the pages and a JSON API. Live data is files in `DATA_DIR`.
- Admin login uses the same scrypt hash and `sh_session` cookie as the imported server. There is no sign-up, invite, or player session.
- The map (`campaign_map.html`, `js/map.js`) draws nodes and the routes between them as SVG. An admin can add, move, rename, relink, and delete nodes from the map or from the Nodes page.
- Results stay pending until the opponent confirms. The admin can record that confirmation, dispute a result, or clear it. Phone reporting is not built yet.
- Pages share `css/site-nav.css` (theme tokens plus the header and phone nav). Script and stylesheet URLs are cache-busted with a content hash. HTML itself is `no-store`.

## Local start

```bash
npm start
# open http://localhost:3847
```

Node 22 or newer. There is no build step. Tests:

```bash
npm test
```

The admin username defaults to `admin`. Set `CAMPAIGN_ADMIN_PASSWORD` before the first boot. If it is missing, the server generates a password and prints it once. To rotate it and sign the admin out, set both of these and restart, then remove the force flag:

```bash
CAMPAIGN_ADMIN_PASSWORD=the-new-password
CAMPAIGN_ADMIN_FORCE_PASSWORD=1
```

The old published password `change-me` is rejected when `NODE_ENV=production` or the process is running on Render.

## Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `PORT` | No | HTTP port. Default `3847`. |
| `HOST` | No | Bind address. Default `0.0.0.0`. |
| `DATA_DIR` | Production | Directory for the JSON store. Default `./data`, which is fine locally. Production refuses to start if this is unset or inside the app directory, unless `ALLOW_EPHEMERAL_DATA=1`. |
| `CAMPAIGN_ADMIN_LOGIN` | No | Admin username. Default `admin`. |
| `CAMPAIGN_ADMIN_PASSWORD` | Production | Password used when the admin account is created, and when a force-reset runs. |
| `CAMPAIGN_ADMIN_FORCE_PASSWORD` | No | Set to `1` with `CAMPAIGN_ADMIN_PASSWORD` to re-hash the admin and delete every session on boot. |
| `NODE_ENV` | No | `production` rejects the old published admin password and requires a persistent `DATA_DIR`. |
| `ALLOW_EPHEMERAL_DATA` | No | Set to exactly `1` to boot production against a data directory that will be wiped. |
| `CORS_ORIGINS` | No | Extra browser origins allowed to call the API with cookies. Same-origin is always allowed. |
| `TRUST_PROXY` | No | Leave unset when Node sees the client directly. Set to `1` behind Render's proxy. |
| `MAX_BODY_BYTES` | No | Request body limit. Default `1048576`. |

`SEED_SAMPLE_CAMPAIGN` is ignored. This app does not ship a named roster.

`data/accounts.json` and `data/sessions.json` are created on first use and are gitignored. The tracked `data/systems.json` and `data/baseline/systems.json` are a small starter map of nodes and routes, not a campaign sector. `data/games.json` starts empty. `data/meta.json` holds the event name and blurb.

A fresh `DATA_DIR` with no `systems.json` is seeded from `data/baseline/systems.json`.

## Roadmap

Each later change is its own small PR.

1. **Import and strip** (this PR). Server, admin login, node-and-route map, result confirmation, phone pages, tests.
2. **Data model.** Event, map areas, entrants, rounds, pairings, results, and area control. See [docs/data-model.md](docs/data-model.md).
3. **Area map.** Admin zone editor on an uploaded map image, on top of the node map.
4. **Registration and roster.** Check-in list, plus Apex and Grudge match entry. No real names committed to the repo.
5. **Swiss pairing.** Pairing engine and a review step for the organiser.
6. **Area and table assignment.** Printable pairings and QR codes.
7. **Phone results.** A player reports a result with an event code and that round's QR code, and the opponent confirms on their phone. No player account.
8. **Scoring and narrative log.** Standings and a log of what the results did to the story.
9. **Projector dashboard and theme.** A view for the room, and the event theme.
10. **Export and deploy.** Backup/export, then a real Render service. `render.yaml` in this repo is only a draft. See [DEPLOY.md](DEPLOY.md). Do not create a service from this PR.

## Project layout

- `server.js` — API and static server
- `lib/model.js` — event data model and validation
- [docs/data-model.md](docs/data-model.md) — store layout
- `index.html` — home
- `area-map.html` — public map on the uploaded image, shaded by who holds each area
- `map-editor.html` — admin zone editor
- `campaign_map.html`, `js/map.js` — node-and-route map
- `systems.html` — node and route editor
- `games.html` — results and opponent confirmation
- `login.html` — admin login
- `js/api.js` — browser client
- `css/site-nav.css` — shared theme and header
- `data/` — JSON store and the baseline map
- `test/` — Node test runner
