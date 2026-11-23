# Event data model

One weekend, one event, one JSON store in `DATA_DIR`. Players do not have accounts. The only login is the event admin (`event_admin`). An old `campaign_admin` account is still accepted and rewritten to `event_admin` on boot or login.

The current map page still edits `systems.json` (`sys_id`, `sys_links`). On boot those rows are copied into `map.json` as areas, and later edits stay in step. New code should use the area names.

Scoring and area control are fixed. A later PR calculates standings. This store only records the inputs and checks they are legal.

## Rules the records follow

- 4 or 5 rounds. Every game is Loyalist against Traitor.
- Campaign points: win 3, tie 1, loss 0. A bye is a win worth at least 10 VP for the player who sits out.
- Swiss pairing must not repeat a pair. Apex and grudge matches are entered by the organiser, stay locked, and follow the same no-rematch rule.
- Pairings and rounds move draft, then approved, then published. A record cannot be published straight from draft.
- Area control uses campaign points scored in that area, added up across rounds. The side with more points holds it. A tie keeps the previous holder, or stays neutral if nobody held it. A tie does not go to Traitor.
- The faction winner is the side that holds the most areas. Best general is the top Loyalist and the top Traitor, ordered by campaign points, then VP difference, then strength of schedule.
- Each event has an `event_code`. Each round has a `qr_token`. Both stay off public responses. Phone reporting is a later PR.

## Files

| File | What it holds |
| --- | --- |
| `event.json` | Name, blurb, code, 4 or 5 rounds, scoring, tiebreak order |
| `map.json` | Optional image file name, and the areas |
| `players.json` | Entrants: display name, faction, `dropped`, `bye` |
| `rounds.json` | Round number, state, QR token |
| `pairings.json` | Table, area, kind, locked, state, the two entrants |
| `results.json` | VP, outcome, confirmation, campaign points |
| `control.json` | Per round, per area: points that round, running totals, holder |
| `systems.json` | The same areas in the old `sys_id` / `sys_links` shape, for the current map page |
| `games.json` | The interim result board from the first PR. New games belong in `results.json` |
| `accounts.json`, `sessions.json` | The event admin only. Not in git |

An area has `area_id`, `name`, `shape` (`point` or `outline`), `points`, `x`, `y`, `routes` (other area ids), `tables`, `scenario`, and `notes`. A point is one coordinate. An outline needs at least three. `x` and `y` are the position on the current SVG map. The image file itself is not uploaded here. `image.file` is only a name, with no folders in it.

An entrant has a display name and a faction. There is no contact field, real name, email, or Discord id. `dropped` takes them out of later pairings. `bye` is the organiser's flag that this entrant should receive a bye when the round is built. The public entrant list omits that flag.

A pairing `kind` is `normal`, `apex`, `grudge`, or `bye`. Apex and grudge are always `locked`. A bye names one entrant. Any other pairing names one Loyalist and one Traitor. `table` and `area_id` can wait until the organiser assigns them. `state` is `draft`, `approved`, or `published`. Visitors only receive published pairings.

A result belongs to one pairing. The outcome has to match the VP: higher wins, equal is a tie. Confirmation is `pending`, `confirmed`, or `disputed`. Opponent confirmation is only valid when one of the two sides reported the result. A bye is stored as confirmed by the admin.

`control.json` stores the points earned in that area in that round (`loyalist_points`, `traitor_points`) and the running totals. The holder is checked against those totals and the previous holder. Posting Traitor as the holder of a 0–0 area is rejected.

## Admin API

Writes need the event admin. Visitors can read the public shapes.

- `GET` / `PUT /api/event`
- `GET` / `PUT /api/map` for the image reference
- `GET` / `POST /api/areas`, `PUT` / `DELETE /api/areas/:id`
- `GET` / `POST /api/players`, `PUT` / `DELETE /api/players/:id`
- `GET` / `POST /api/rounds`, `PUT` / `DELETE /api/rounds/:id`
- `GET` / `POST /api/pairings`, `PUT` / `DELETE /api/pairings/:id`
- `GET` / `POST /api/results`, `PUT` / `DELETE /api/results/:id`, `POST /api/results/:id/confirm`, `POST /api/results/:id/dispute`
- `GET` / `POST /api/control`
- `GET /api/public/event`, `/map`, `/entrants` omit the event code, QR tokens, and the bye flag

The old `/api/systems` and `/api/games` routes still serve the current pages.
