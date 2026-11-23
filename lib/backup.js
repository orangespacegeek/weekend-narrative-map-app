/**
 * Event backup bundle and CSV exports.
 * Accounts and sessions stay out of the bundle so a restore cannot replace the admin login.
 */
"use strict";

const {
  FACTIONS,
  FORBIDDEN_PLAYER_KEYS,
  PAIRING_KINDS,
  RECORD_STATES,
  OUTCOMES,
  CONFIRMATIONS,
  SHAPES
} = require("./model");

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
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
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

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value) {
  return Number.isInteger(value) && value >= 1;
}

function seatId(value) {
  if (value == null || value === "") return null;
  return isId(value) ? value : false;
}

function validateEntrant(player) {
  if (!isRecord(player)) return "Each entrant must be an object";
  if (!isId(player.player_id)) return "Each entrant needs a player id";
  if (typeof player.display_name !== "string" || !player.display_name.trim()) return "Each entrant needs a display name";
  if (!FACTIONS.includes(player.faction)) return "Each entrant needs a faction";
  if (player.army != null && typeof player.army !== "string") return "Each entrant army must be text";
  if (player.dropped != null && typeof player.dropped !== "boolean") return "Each entrant dropped flag must be true or false";
  if (player.bye != null && typeof player.bye !== "boolean") return "Each entrant bye flag must be true or false";
  if (player.is_stand_in != null && typeof player.is_stand_in !== "boolean") return "Each entrant stand-in flag must be true or false";
  for (const key of FORBIDDEN_PLAYER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(player, key)) return "Entrants cannot include contact details";
  }
  return null;
}

function validateRoundItem(round) {
  if (!isRecord(round)) return "Each round must be an object";
  if (!isId(round.round_id)) return "Each round needs a round id";
  if (!isId(round.number)) return "Each round needs a round number";
  if (!RECORD_STATES.includes(round.state)) return "Each round needs a state";
  if (round.qr_token != null && typeof round.qr_token !== "string") return "Each round token must be text";
  return null;
}

function validatePairingItem(pairing) {
  if (!isRecord(pairing)) return "Each pairing must be an object";
  if (!isId(pairing.pairing_id)) return "Each pairing needs a pairing id";
  if (!isId(pairing.round_id)) return "Each pairing needs a round id";
  if (!PAIRING_KINDS.includes(pairing.kind)) return "Each pairing needs a kind";
  if (!RECORD_STATES.includes(pairing.state)) return "Each pairing needs a state";
  if (pairing.locked != null && typeof pairing.locked !== "boolean") return "Each pairing locked flag must be true or false";
  if (pairing.table != null && typeof pairing.table !== "string") return "Each pairing table must be text";
  if (pairing.area_id != null && pairing.area_id !== "" && !isId(pairing.area_id)) return "Each pairing area must be an id";
  const loyalist = seatId(pairing.loyalist_id);
  const traitor = seatId(pairing.traitor_id);
  if (loyalist === false || traitor === false) return "Each pairing seat must be an entrant id";
  const seats = [loyalist, traitor].filter(Boolean).length;
  if (pairing.kind === "bye" && seats !== 1) return "A bye pairing names one entrant";
  if (pairing.kind !== "bye" && seats !== 2) return "A game pairing names both entrants";
  return null;
}

function validateResultItem(result) {
  if (!isRecord(result)) return "Each result must be an object";
  if (!isId(result.result_id)) return "Each result needs a result id";
  if (!isId(result.pairing_id)) return "Each result needs a pairing id";
  if (result.round_id != null && !isId(result.round_id)) return "Each result round must be an id";
  if (!OUTCOMES.includes(result.outcome)) return "Each result needs an outcome";
  if (result.confirmation != null && !CONFIRMATIONS.includes(result.confirmation)) return "Each result confirmation is not valid";
  return null;
}

function validateAreaItem(area) {
  if (!isRecord(area)) return "Each area must be an object";
  if (!isId(area.area_id)) return "Each area needs an area id";
  if (typeof area.name !== "string" || !area.name.trim()) return "Each area needs a name";
  if (!SHAPES.includes(area.shape)) return "Each area needs a shape";
  return null;
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
    const error = validateEntrant(player);
    if (error) return fail(error);
  }
  for (const round of files["rounds.json"]) {
    const error = validateRoundItem(round);
    if (error) return fail(error);
  }
  for (const pairing of files["pairings.json"]) {
    const error = validatePairingItem(pairing);
    if (error) return fail(error);
  }
  for (const result of files["results.json"]) {
    const error = validateResultItem(result);
    if (error) return fail(error);
  }
  for (const area of files["map.json"].areas) {
    const error = validateAreaItem(area);
    if (error) return fail(error);
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
