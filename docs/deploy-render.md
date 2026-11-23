# Deploy on Render

This is a walkthrough only. Nothing in the repo creates a Render service. Do not click Blueprint until you have read the cost section and you want a paid, always-on host.

`render.yaml` describes one Node web service. Applying that blueprint is what creates the service.

## What it costs

Confirm the live numbers at [render.com/pricing](https://render.com/pricing) before you pay. These figures are the ones to review:

- **Free instance: $0/month.** It sleeps when idle. A free instance cannot mount a persistent disk, so `data/` is wiped on every restart or deploy. That is fine for a dry run. It is not fine for a live weekend, because the roster, pairings, and results would disappear.
- **Starter + 1 GB persistent disk: about $7.25/month.** Starter (`0.5 CPU / 512 MB`, always on) is $7/month. A 1 GB disk is $0.25 per GB per month, so $0.25. Together that is about $7.25/month. After the event, download a backup, then suspend or delete the service so the charge stops.

## Create the service

1. Push this repo to GitHub.
2. In the Render dashboard, create a Blueprint from `render.yaml`, or create a web service by hand with the same settings:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
   - Instance type: Starter (not Free) if this is the real event
   - Disk: 1 GB mounted at `/var/data`
3. Set the environment:
   - `NODE_ENV` = `production`
   - `DATA_DIR` = `/var/data`
   - `TRUST_PROXY` = `1`
   - `CAMPAIGN_ADMIN_LOGIN` = `admin` (or another username)
   - `CAMPAIGN_ADMIN_PASSWORD` = a long password you type into Render. `sync: false` in the blueprint means Render asks you for it and does not store it in git.
4. Deploy, then open `https://your-service.onrender.com/health`. You should see `{"ok":true,"service":"weekend-narrative-map"}`.
5. Sign in on the site with that admin password. The first boot creates the admin account from the environment variable.

Production refuses to boot if `DATA_DIR` is missing or points inside the app folder, unless `ALLOW_EPHEMERAL_DATA=1`. Do not set that override for a live event.

## Back up and restore

On the home page, while signed in as the event admin:

- **Download backup** saves one JSON file. It holds the event files and, if you uploaded one, the map image. It does not include admin passwords or session tokens.
- **Export CSV** downloads standings and confirmed results. Those sheets use display names, factions, and armies only.
- **Restore backup** replaces the event files with a backup you choose. A file that is not a valid backup is rejected and the live data is left as it was.

Download a backup before the event, once during it, and again before you delete the Render service. Keep that file somewhere that is not the Render disk. Restoring it onto a new boot brings the roster, pairings, results, and map image back. You still sign in with the password set in the environment.

To rotate the admin password later, set `CAMPAIGN_ADMIN_PASSWORD` to the new value and `CAMPAIGN_ADMIN_FORCE_PASSWORD` to `1`, redeploy, sign in, then remove the force flag and redeploy again.
