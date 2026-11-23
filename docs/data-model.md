# Event data model

One weekend, one event, one JSON store in `DATA_DIR`. Players do not have accounts. The only login is the event admin (`event_admin`). An old `campaign_admin` account is still accepted and rewritten to `event_admin` on boot or login.

The current map page still edits `systems.json` (`sys_id`, `sys_links`). On boot those rows are copied into `map.json` as areas, and later edits stay in step. New code should use the area names.

Scoring and area control are fixed. A later PR calculates standings. This store only records the inputs and checks they are legal.

## Rules the records follow

- 4 or 5 rounds. Every game is Loyalist against Traitor.
- Campaign points: win 3, tie 1, loss 0. A bye is a win worth at least 10 VP for the player who sits out.
- No rematches anywhere. A normal, Apex, or Grudge pairing is rejected when those two entrants have already played each other. An entrant also cannot sit in two matches in the same round. Apex and Grudge matches stay locked. A dropped entrant is left out of later pairings; their earlier matches stay.
- Swiss pairing keeps the locked Apex and Grudge matches and pairs the rest Loyalist against Traitor, closest rank first. Rank is campaign points, then VP difference, then strength of schedule. A fully tied pair is ordered by entrant id, or by a seed when one is supplied. If the sides are unequal, the larger side gives byes until the counts match. A bye goes to the lowest-ranked player on that side who has not had one; it is a win worth at least 10 VP. If no rematch-free pairing exists, the round is left unchanged and the organiser is told. Draft pairings stay off the public list until the organiser approves and publishes them.
- An army name cannot contain an email address or a phone number.
- Pairings and rounds move draft, then approved, then published. A record cannot be published straight from draft.
- Area control is decided each round from the campaign points scored in that area in that round. The side with more points takes it. A tie keeps the previous holder, or stays neutral if nobody held it. Earlier rounds are not added in. The history of each round is kept for the narrative log.
- The faction winner is the side holding the most areas at the end. If both sides hold the same number, the side with more total campaign points wins. If that is also equal, the event is tied. Best general is the top Loyalist and the top Traitor, ordered by campaign points, then VP difference, then strength of schedule.
- Each event has an `event_code`. Each round has a `qr_token`. Both stay off public responses. Phone reporting is a later PR.

## Files

| File | What it holds |
| --- | --- |
| `event.json` | Name, blurb, code, 4 or 5 rounds, scoring, tiebreak order |
| `map.json` | Optional image file name, and the areas |
| `players.json` | Entrants: display name, faction, optional army, `dropped`, `bye` |
| `rounds.json` | Round number, state, QR token |
| `pairings.json` | Table, area, kind, locked, state, the two entrants |
| `results.json` | VP, outcome, confirmation, campaign points |
| `control.json` | One row per round per area: that round's points, the previous holder, and the holder after the round |
| `systems.json` | The same areas in the old `sys_id` / `sys_links` shape, for the current map page |
| `games.json` | The interim result board from the first PR. New games belong in `results.json` |
| `accounts.json`, `sessions.json` | The event admin only. Not in git |

An area has `area_id`, `name`, `shape` (`point` or `outline`), `points`, `x`, `y`, `routes` (other area ids), `tables`, `scenario`, and `notes`. A point is one coordinate. An outline needs at least three. `points` are pixels on the uploaded map image. `x` and `y` stay in the 800 by 560 node-map box so the older node page still has a position.

The event admin uploads a PNG or JPEG to `POST /api/map/image`. The bytes are stored under `DATA_DIR/maps/` as `event-map.png` or `event-map.jpg`, and `map.json` records that file name plus the pixel size. Visitors load the picture from `GET /api/map/image`. `PUT /api/map` can replace the area list in one save. Both writes are admin-only and run the same area checks.

An entrant has a display name, a faction, and an optional `army` (the legion or army name, free text). `army` is public, next to the display name and faction. There is no contact field, real name, email, or Discord id. `dropped` takes them out of later pairings. `bye` is the organiser's flag that this entrant should receive a bye when the round is built. The public entrant list omits that flag.

A pairing `kind` is `normal`, `apex`, `grudge`, or `bye`. Apex and grudge are always `locked`. A bye names one entrant. Any other pairing names one Loyalist and one Traitor. `table` and `area_id` can wait until the organiser assigns them. `state` is `draft`, `approved`, or `published`. Visitors only receive published pairings.

A result belongs to one pairing. The outcome has to match the VP: higher wins, equal is a tie. Confirmation is `pending`, `confirmed`, or `disputed`. Opponent confirmation is only valid when one of the two sides reported the result. A bye is stored as confirmed by the admin.

`control.json` stores one row per area per round: `loyalist_points` and `traitor_points` scored there that round, `previous_controller`, and `controller`. The holder is checked against that round only. A 3–0 round takes the area even if the other side led it before. A 0–0 or 3–3 round keeps the previous holder, and a tied area that nobody has held stays neutral. Posting Traitor as the holder of a tied area is rejected.

## Admin API

Writes need the event admin. Visitors can read the public shapes.

- `GET` / `PUT /api/event`
- `GET` / `PUT /api/map` for the image reference and, on PUT, a full area list
- `GET` / `POST /api/map/image` to read or upload the PNG or JPEG
- `GET` / `POST /api/areas`, `PUT` / `DELETE /api/areas/:id`
- `GET` / `POST /api/players`, `PUT` / `DELETE /api/players/:id`
- `GET` / `POST /api/rounds`, `PUT` / `DELETE /api/rounds/:id`
- `GET` / `POST /api/pairings`, `PUT` / `DELETE /api/pairings/:id`
- `GET` / `POST /api/results`, `PUT` / `DELETE /api/results/:id`, `POST /api/results/:id/confirm`, `POST /api/results/:id/dispute`
- `GET` / `POST /api/control`
- `GET /api/public/event`, `/map`, `/entrants` omit the event code, QR tokens, and the bye flag

The old `/api/systems` and `/api/games` routes still serve the current pages.
