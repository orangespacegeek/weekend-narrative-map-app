/**
 * Event backup bundle and CSV exports.
 * Accounts and sessions stay out of the bundle so a restore cannot replace the admin login.
 */
"use strict";

const { FACTIONS, FORBIDDEN_PLAYER_KEYS } = require("./model");

const FORMAT = "weekend-event-backup";
const VERSION = 1;

const FILE_NAMES = [
  "event.json",
  "map.json",
  "players.json",
  "rounds.json",
  "pairings.json",
  "results.json",
  "narrative.json",
  "systems.json",
  "games.json",
  "meta.json"
];

const LIST_FILES = new Set([
  "players.json",
  "rounds.json",
  "pairings.json",
  "results.json",
  "narrative.json",
  "systems.json",
  "games.json"
]);

function fail(error) {
  return { ok: false, error };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
  if (/[",\n\r]/.test(safe)) return '"' + safe.replace(/"/g, '""') + '"';
  return safe;
}

function csv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function standingsCsv(scored) {
  const rows = [["faction", "rank", "display_name", "army", "wins", "losses", "ties", "campaign_points", "vp_diff", "strength_of_schedule"]];
  ["Loyalist", "Traitor"].forEach((faction) => {
    const list = faction === "Loyalist" ? scored.loyalists : scored.traitors;
    (list || []).forEach((row) => {
      rows.push([
        faction,
        row.rank,
        row.display_name,
        row.army || "",
        row.wins,
        row.losses,
        row.ties,
        row.campaign_points,
        row.vp_diff,
        row.strength_of_schedule
      ]);
    });
  });
  return csv(rows);
}

function resultsCsv(results, pairings, players, rounds) {
  const rows = [[
    "round",
    "table",
    "kind",
    "loyalist",
    "loyalist_faction",
    "loyalist_army",
    "traitor",
    "traitor_faction",
    "traitor_army",
    "loyalist_vp",
    "traitor_vp",
    "outcome",
    "note"
  ]];
  const pairingById = new Map((pairings || []).map((pairing) => [Number(pairing.pairing_id), pairing]));
  const playerById = new Map((players || []).map((player) => [Number(player.player_id), player]));
  const roundById = new Map((rounds || []).map((round) => [Number(round.round_id), round]));
  (results || [])
    .filter((result) => result && result.confirmation === "confirmed")
    .forEach((result) => {
      const pairing = pairingById.get(Number(result.pairing_id));
      if (!pairing || pairing.state !== "published") return;
      const loyal = playerById.get(Number(pairing.loyalist_id));
      const traitor = playerById.get(Number(pairing.traitor_id));
      const round = roundById.get(Number(result.round_id));
      rows.push([
        round ? round.number : result.round_id,
        pairing.table || "",
        pairing.kind,
        loyal ? loyal.display_name : "",
        loyal ? loyal.faction : "",
        loyal && loyal.army ? loyal.army : "",
        traitor ? traitor.display_name : "",
        traitor ? traitor.faction : "",
        traitor && traitor.army ? traitor.army : "",
        result.loyalist_vp == null ? "" : result.loyalist_vp,
        result.traitor_vp == null ? "" : result.traitor_vp,
        result.outcome,
        result.note || ""
      ]);
    });
  return csv(rows);
}

function validateBackup(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return fail("Backup must be a JSON object");
  if (bundle.format !== FORMAT || bundle.version !== VERSION) return fail("Backup format is not recognised");
  if (!bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) return fail("Backup files are missing");
  const extra = Object.keys(bundle.files).filter((name) => !FILE_NAMES.includes(name));
  if (extra.length) return fail("Backup contains an unexpected file");
  const files = {};
  for (const name of FILE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(bundle.files, name)) return fail("Backup is missing " + name);
    const value = bundle.files[name];
    if (LIST_FILES.has(name)) {
      if (!Array.isArray(value)) return fail(name + " must be a list");
    } else if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail(name + " must be an object");
    }
    files[name] = value;
  }
  if (!Array.isArray(files["map.json"].areas)) return fail("map.json needs an area list");
  for (const player of files["players.json"]) {
    if (!player || typeof player !== "object" || Array.isArray(player)) return fail("Each entrant must be an object");
    if (typeof player.display_name !== "string" || !player.display_name.trim()) return fail("Each entrant needs a display name");
    if (!FACTIONS.includes(player.faction)) return fail("Each entrant needs a faction");
    for (const key of FORBIDDEN_PLAYER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(player, key)) return fail("Entrants cannot include contact details");
    }
  }
  let image = null;
  if (bundle.map_image != null) {
    const pic = bundle.map_image;
    if (!pic || typeof pic !== "object" || Array.isArray(pic)) return fail("Map image is not valid");
    if (pic.file !== "event-map.png" && pic.file !== "event-map.jpg") return fail("Map image file is not valid");
    if (pic.mime !== "image/png" && pic.mime !== "image/jpeg") return fail("Map image type is not valid");
    if (typeof pic.data !== "string" || !pic.data) return fail("Map image data is missing");
    if (pic.file === "event-map.png" && pic.mime !== "image/png") return fail("Map image type does not match the file");
    if (pic.file === "event-map.jpg" && pic.mime !== "image/jpeg") return fail("Map image type does not match the file");
    const bytes = Buffer.from(pic.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== pic.data.replace(/\s/g, "")) return fail("Map image data is not valid base64");
    image = { file: pic.file, mime: pic.mime, bytes };
  }
  return { ok: true, files, image };
}

module.exports = {
  FORMAT,
  VERSION,
  FILE_NAMES,
  standingsCsv,
  resultsCsv,
  validateBackup
};
