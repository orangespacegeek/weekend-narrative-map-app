# Deploy notes

This file is documentation only. Nothing in this PR creates a Render service, a disk, or any other host.

Deploy is PR 10. Until then, run the app locally with `npm start`.

When that PR lands, the shape is:

- A Node web service, build `npm install`, start `npm start`.
- Health check at `/health`.
- A persistent disk mounted outside the app directory, with `DATA_DIR` pointed at it. Production refuses to boot if `DATA_DIR` is unset or inside the repo, unless `ALLOW_EPHEMERAL_DATA=1` (data will not survive a restart).
- `NODE_ENV=production`.
- `CAMPAIGN_ADMIN_PASSWORD` set in the host environment, not in git.
- `TRUST_PROXY=1` when the host's proxy appends the client IP.

`render.yaml` is a draft blueprint for that later PR. Applying it would create a paid web service. Do not apply it from this PR.

Free instances cannot mount a disk, and this app's JSON store has to survive restarts, so a real deploy needs a plan that includes a disk. A service that sleeps will be slow on the first request after idle. This app does not keep a host awake.

Player accounts are not part of the deploy. Do not add invite files, a player password, or a roster of real names to the host disk by hand.
