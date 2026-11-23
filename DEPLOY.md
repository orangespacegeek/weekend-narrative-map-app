# Deploy notes

This file is documentation only. Nothing here creates a Render service.

The Render walkthrough, including the monthly cost, is in [docs/deploy-render.md](docs/deploy-render.md). `render.yaml` is the blueprint that page describes. Applying it in the Render dashboard is what creates the paid service.

Free instances cannot mount a disk. A live weekend needs the Starter instance and the 1 GB disk so the event survives a restart. Download a backup before you delete the service.
