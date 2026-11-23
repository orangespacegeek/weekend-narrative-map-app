# Event data model

One weekend, one event, one JSON store in `DATA_DIR`. Players do not have accounts. The only login is the event admin (`event_admin`). An old `campaign_admin` account is still accepted and rewritten to `event_admin` on boot or login.

The current map page still edits `systems.json` (`sys_id`, `sys_links`). On boot those rows are copied into `map.json` as areas, and later edits stay in step. New code should use the area names.

Scoring and area control are fixed. Standings, the map, and the narrative log are calculated from confirmed results on published rounds.

## Rules the records follow

- 4 or 5 rounds. Every game is Loyalist against Traitor.
- Campaign points: win 3, tie 1, loss 0. A bye is a win worth at least 10 VP for the player who sits out.
- No rematches anywhere. A normal, Apex, or Grudge pairing is rejected when those two entrants have already played each other. An entrant also cannot sit in two matches in the same round. Apex and Grudge matches stay locked. A dropped entrant is left out of later pairings; their earlier matches stay.
- Swiss pairing keeps the locked Apex and Grudge matches and pairs the rest Loyalist against Traitor, closest rank first. Rank is campaign points, then VP difference, then strength of schedule. A fully tied pair is ordered by entrant id, or by a seed when one is supplied. Dropped entrants are skipped. Stand-in entrants are not counted in either side. If the real sides are unequal, each extra player on the larger side is paired with a TO stand-in on the smaller side. That match is a normal game: it gets a table, area, and scenario, and the player reports it on the phone form. An existing `is_stand_in` entrant on the smaller side is used first, unless that pairing would be a rematch, in which case a new stand-in slot is created. New slots are named `TO Stand-in`, then `TO Stand-in 2`, and are reused in later rounds. The stand-in game goes to the lowest-ranked eligible player on the larger side who has not played a stand-in yet. If everyone there already has, the lowest-ranked player plays another and the response carries a warning. The game counts for that player's campaign points, VP difference, and strength of schedule, and for the round's area control and the faction totals. The stand-in entrant is left out of Best General. A bye is used only when the organiser assigns one in review. A bye still has no table, and its result of at least 10 VP is written when the round is published. The no-rematch rule stays strict for every real-player pairing, including Apex and Grudge. If no rematch-free pairing exists, the round is left unchanged and the organiser is told. Draft pairings stay off the public list until the organiser approves and publishes them.
- An army name cannot contain an email address or a phone number.
- Pairings and rounds move draft, then approved, then published. A record cannot be published straight from draft.
- Area control is decided each round from the campaign points scored in that area in that round. The side with more points takes it. A tie keeps the previous holder, or stays neutral if nobody held it. Earlier rounds are not added in. The history of each round is kept for the narrative log.
- The faction winner is the side holding the most areas at the end. If both sides hold the same number, the side with more total campaign points wins. If that is also equal, the event is tied. Best general is the top Loyalist and the top Traitor, ordered by campaign points, then VP difference, then strength of schedule.
- Each event has an `event_code`. Each round has a `qr_token`. Neither appears in a public response. The organiser's QR encodes the event code and the round number into `/report.html`, and only an admin can fetch that picture or the QR sheet. The public pairing sheet has no QR. `qr_token` is not in that URL. The phone form reads the code from the link, removes it from the address bar, and sends it only on the report POST. A wrong or missing code is rejected without repeating the code, and too many bad attempts are rate-limited.

## Files

| File | What it holds |
| --- | --- |
| `event.json` | Name, blurb, code, 4 or 5 rounds, scoring, tiebreak order, site theme |
| `map.json` | Optional image file name, and the areas |
| `players.json` | Entrants: display name, faction, optional army, `dropped`, `bye`, `is_stand_in` |
| `rounds.json` | Round number, state, QR token |
| `pairings.json` | Table, area, kind, locked, state, the two entrants |
| `results.json` | VP, outcome, confirmation, campaign points |
| `systems.json` | The same areas in the old `sys_id` / `sys_links` shape, for the current map page |
| `games.json` | Retired interim board. New results belong in `results.json`. The old routes remain so older clients do not 404 |
| `narrative.json` | Optional organiser recap for each round |
| `accounts.json`, `sessions.json` | The event admin only. Not in git |

An area has `area_id`, `name`, `shape` (`point` or `outline`), `points`, `x`, `y`, `routes` (other area ids), `tables`, `scenario`, and `notes`. A point is one coordinate. An outline needs at least three. `points` are pixels on the uploaded map image. `x` and `y` stay in the 800 by 560 node-map box so the older node page still has a position.

The event admin uploads a PNG or JPEG to `POST /api/map/image`. The bytes are stored under `DATA_DIR/maps/` as `event-map.png` or `event-map.jpg`, and `map.json` records that file name plus the pixel size. Visitors load the picture from `GET /api/map/image`. `PUT /api/map` can replace the area list in one save. Both writes are admin-only and run the same area checks.

An entrant has a display name, a faction, and an optional `army` (the legion or army name, free text). `army` is public, next to the display name and faction. There is no contact field, real name, email, or Discord id. `dropped` takes them out of later pairings. `is_stand_in` marks a TO stand-in. The organiser can set it on the roster, and the public roster shows a TO Stand-in badge. `bye` is stored for the organiser and is omitted from the public list. It does not by itself create a pairing. A bye exists only when the organiser assigns a pairing with `kind: bye` in review.

A pairing `kind` is `normal`, `apex`, `grudge`, or `bye`. Apex and grudge are always `locked`. A bye names one entrant and has no table. Any other pairing names one Loyalist and one Traitor. `state` is `draft`, `approved`, or `published`. Visitors only receive published pairings. Generating again drops this round's unlocked drafts, including byes, before the engine runs, and leaves locked Apex and Grudge matches in place.

When a round is generated, each game is given the next free table from the map. Areas are taken in `area_id` order. An area with table numbers contributes one seat per number, and the game is stored with that area so its scenario prints with the table. An area with a scenario and no table numbers contributes one seat, labeled with the scenario's first 16 characters. A table the organiser already set on a locked Apex or Grudge match is kept. If two games in the round share a table, the save still stands and the response warns that the table is booked twice. A table that is not on the map is kept and warned about, so an older pairing is not rejected. Games left over when the map runs out of seats stay unassigned, with a warning. The printed sheet for a round is available only after every pairing in that round is published. It lists games by table and players alphabetically, with display name, faction, and army.

A result belongs to one pairing. The outcome has to match the VP: higher wins, equal is a tie. Confirmation is `pending`, `confirmed`, or `disputed`. Opponent confirmation is only valid when one of the two sides reported the result. A bye result is written when the round is published, confirmed by the admin, and worth at least 10 VP. A phone report is pending until the other player sends the same scores, which confirms it, or different scores, which flags it for the organiser. An optional note is plain text, at most 240 characters, and cannot look like an email address or a phone number. Visitors only receive confirmed results whose pairing is published.

Live area control is calculated from confirmed results on published rounds. It is not stored in `control.json`. Each published round has a row per area: that round's campaign points, the previous holder, and the holder afterwards. A side with more points takes the area. A tie keeps the previous holder, and a tied area that nobody has held stays neutral. `GET /api/control` returns that calculated history. Pending and unpublished results are left out. The hall view at `/projector` uses the same numbers.

## Admin API

Writes need the event admin. Visitors can read the public shapes.

- `GET` / `PUT /api/event`
- `GET` / `PUT /api/map` for the image reference and, on PUT, a full area list
- `GET` / `POST /api/map/image` to read or upload the PNG or JPEG
- `GET` / `POST /api/areas`, `PUT` / `DELETE /api/areas/:id`
- `GET` / `POST /api/players`, `PUT` / `DELETE /api/players/:id`
- `GET` / `POST /api/rounds`, `PUT` / `DELETE /api/rounds/:id`
- `GET /api/rounds/:id/sheet` for a published round's print data
- `GET /api/rounds/:id/qr.svg` is the admin QR for that round. `?download=1` sends it as a file. Visitors are refused.
- `GET /print/round/:number` is the public paper pairing sheet, with no QR. `GET /print/round/:number/organiser` is the same sheet with the QR, and it requires the admin. `GET /print/qr-sheet` is the admin QR sheet.
- `GET` / `POST /api/pairings`, `PUT` / `DELETE /api/pairings/:id`
- `GET` / `POST /api/results`, `PUT` / `DELETE /api/results/:id`, `POST /api/results/:id/confirm`, `POST /api/results/:id/reject`, `POST /api/results/:id/dispute`
- `GET /api/report?round=` lists published tables for the phone form. `POST /api/report` files a report and requires the event code. The code is not copied into the response.
- `GET /api/control` is the calculated history. There is no control file to post.
- `GET /api/projector` is the hall display. `GET` / `POST /api/theme` reads or sets the site style. The post needs the admin and the CSRF check.
- `GET /api/standings` for the public scoreboard and Best General tables
- `GET /api/narrative` for the public log. `POST /api/narrative` saves an organiser recap and needs the admin and the CSRF check.
- `GET /api/admin/backup` downloads the event bundle, including the map image when one is stored. `POST /api/admin/restore` replaces the event files from that bundle. `GET /api/admin/standings.csv` and `GET /api/admin/results.csv` download confirmed public fields only. All four need the admin, and the restore needs the CSRF check. The bundle does not include passwords or sessions.
- `GET /api/public/event`, `/map`, `/entrants` omit the event code, QR tokens, and the bye flag. Public entrants include `is_stand_in`

The old `/api/systems` and `/api/games` routes still serve the current pages.
