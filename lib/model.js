/**
 * Weekend event data model.
 *
 * Later PRs build the pairing engine, the zone editor, and the phone form.
 * This module is the shape those pieces read and write, plus the checks that
 * keep a record valid. It does not pair a round or score a whole event.
 */
"use strict";

const crypto = require("crypto");

const FACTIONS = ["Loyalist", "Traitor"];
const PAIRING_KINDS = ["normal", "apex", "grudge", "bye"];
const RECORD_STATES = ["draft", "approved", "published"];
const CONFIRMATIONS = ["pending", "confirmed", "disputed"];
const OUTCOMES = ["loyalist_win", "traitor_win", "tie", "bye"];
const SHAPES = ["point", "outline"];
const CONTROLLERS = ["Loyalist", "Traitor", "neutral"];
const REPORTED_BY = ["loyalist", "traitor", "admin"];
const CONFIRMED_BY = ["opponent", "admin"];
const ADMIN_ROLES = ["event_admin", "campaign_admin"];
const CANONICAL_ADMIN_ROLE = "event_admin";

// Rob's rules. Not the LVO sheet (that summed VP and gave ties to Traitor).
const SCORING = Object.freeze({ win: 3, tie: 1, loss: 0, bye_vp: 10 });
const TIEBREAKERS = Object.freeze(["campaign_points", "vp_diff", "strength_of_schedule"]);
const CONTROL_TIE = "previous_holder";

const FORBIDDEN_PLAYER_KEYS = [
  "contact",
  "email",
  "phone",
  "discord",
  "real_name",
  "player_name",
  "first_name",
  "last_name",
  "instagram",
  "lord_of_war"
];

const EVENT_CODE_ALPHABET = "ACDEFGHJKLMNPQRSTUVWXYZ2345679";

function fail(error) {
  return { ok: false, error };
}

function pass(value) {
  return { ok: true, value };
}

function clip(value, max) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

function normalizeAdminRole(role) {
  return isAdminRole(role) ? CANONICAL_ADMIN_ROLE : role;
}

function generateEventCode() {
  const span = EVENT_CODE_ALPHABET.length * Math.floor(256 / EVENT_CODE_ALPHABET.length);
  let out = "";
  while (out.length < 8) {
    const buf = crypto.randomBytes(16);
    for (const byte of buf) {
      if (byte < span) out += EVENT_CODE_ALPHABET[byte % EVENT_CODE_ALPHABET.length];
      if (out.length === 8) break;
    }
  }
  return out;
}

function generateQrToken() {
  return crypto.randomBytes(16).toString("hex");
}

function defaultEvent(partial) {
  const src = partial && typeof partial === "object" ? partial : {};
  return {
    name: clip(src.name || src.event_name, 80) || "Weekend Event",
    blurb: clip(src.blurb, 280) || "A one-weekend Horus Heresy narrative tournament.",
    event_code: src.event_code || generateEventCode(),
    rounds_planned: src.rounds_planned == null ? 4 : src.rounds_planned,
    current_round: src.current_round == null ? 0 : src.current_round,
    scoring: {
      win: SCORING.win,
      tie: SCORING.tie,
      loss: SCORING.loss,
      bye_vp: SCORING.bye_vp
    },
    tiebreakers: TIEBREAKERS.slice(),
    control_tie: CONTROL_TIE
  };
}

function sameList(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return b.every((item, i) => a[i] === item);
}

function validateEvent(body, existing) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Event must be an object");
  const name = clip(src.name != null ? src.name : existing && existing.name, 80);
  if (!name) return fail("Event name is required");
  const blurb = clip(src.blurb != null ? src.blurb : existing && existing.blurb, 280);
  let rounds = src.rounds_planned != null ? src.rounds_planned : existing && existing.rounds_planned;
  rounds = Number(rounds);
  if (rounds !== 4 && rounds !== 5) return fail("An event has 4 or 5 rounds");
  let current = src.current_round != null ? src.current_round : existing && existing.current_round;
  current = current == null || current === "" ? 0 : Number(current);
  if (!Number.isInteger(current) || current < 0 || current > rounds) {
    return fail("Current round is out of range");
  }
  if (src.scoring && typeof src.scoring === "object") {
    const scoring = src.scoring;
    if (
      Number(scoring.win) !== SCORING.win ||
      Number(scoring.tie) !== SCORING.tie ||
      Number(scoring.loss) !== SCORING.loss ||
      Number(scoring.bye_vp) !== SCORING.bye_vp
    ) {
      return fail("Scoring is fixed: win 3, tie 1, loss 0, and a bye is worth 10 VP");
    }
  }
  if (src.tiebreakers && !sameList(src.tiebreakers, TIEBREAKERS)) {
    return fail("Tiebreakers are campaign points, then VP difference, then strength of schedule");
  }
  if (src.control_tie && src.control_tie !== CONTROL_TIE) {
    return fail("A tied area keeps its previous holder, or stays neutral");
  }
  const code = clip(src.event_code || (existing && existing.event_code) || "", 16);
  return pass({
    name,
    blurb,
    event_code: code || (existing && existing.event_code) || generateEventCode(),
    rounds_planned: rounds,
    current_round: current,
    scoring: { win: SCORING.win, tie: SCORING.tie, loss: SCORING.loss, bye_vp: SCORING.bye_vp },
    tiebreakers: TIEBREAKERS.slice(),
    control_tie: CONTROL_TIE
  });
}

function publicEvent(event) {
  if (!event) return null;
  return {
    name: event.name,
    blurb: event.blurb,
    rounds_planned: event.rounds_planned,
    current_round: event.current_round,
    scoring: event.scoring,
    tiebreakers: event.tiebreakers,
    control_tie: event.control_tie
  };
}

function parseIdList(raw) {
  if (Array.isArray(raw)) return raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(",")
    .map((part) => Number(String(part).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function uniqueIds(ids) {
  const out = [];
  ids.forEach((id) => {
    if (!out.includes(id)) out.push(id);
  });
  return out;
}

function areaFromSystem(sys) {
  const areaId = Number(sys.area_id != null ? sys.area_id : sys.sys_id);
  const x = Number(sys.x != null ? sys.x : sys.sys_x);
  const y = Number(sys.y != null ? sys.y : sys.sys_y);
  const px = Number.isFinite(x) ? x : 400;
  const py = Number.isFinite(y) ? y : 280;
  const routes = uniqueIds(parseIdList(sys.routes != null ? sys.routes : sys.sys_links)).filter((id) => id !== areaId);
  return {
    area_id: areaId,
    name: clip(sys.name || sys.sys_name, 80) || "Area " + areaId,
    shape: sys.shape === "outline" ? "outline" : "point",
    points: [{ x: px, y: py }],
    x: px,
    y: py,
    routes,
    tables: [],
    scenario: null,
    notes: clip(sys.notes != null ? sys.notes : sys.sys_notes, 500)
  };
}

function systemFromArea(area) {
  return {
    sys_id: area.area_id,
    sys_name: area.name,
    sys_links: (area.routes || []).join(","),
    sys_notes: area.notes || "",
    sys_x: area.x,
    sys_y: area.y
  };
}

function mergeSystemEdit(existing, fresh) {
  if (!existing) return fresh;
  const point = existing.shape === "outline" ? existing.points : [{ x: fresh.x, y: fresh.y }];
  return {
    ...fresh,
    shape: existing.shape || fresh.shape,
    points: point,
    tables: existing.tables || [],
    scenario: existing.scenario == null ? null : existing.scenario
  };
}

function readPoint(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeTables(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const out = [];
  for (const item of list) {
    const text = clip(item, 16);
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function validateArea(body, existing, knownIds) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Area must be an object");
  const name = clip(src.name != null ? src.name : src.sys_name != null ? src.sys_name : existing && existing.name, 80);
  if (!name) return fail("Area name is required");
  const shape = src.shape || (existing && existing.shape) || "point";
  if (!SHAPES.includes(shape)) return fail("Area shape must be point or outline");
  const xRaw = src.x != null ? src.x : src.sys_x != null ? src.sys_x : existing && existing.x;
  const yRaw = src.y != null ? src.y : src.sys_y != null ? src.sys_y : existing && existing.y;
  const x = Number(xRaw == null || xRaw === "" ? 400 : xRaw);
  const y = Number(yRaw == null || yRaw === "" ? 280 : yRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fail("Area position must be a number");
  const px = Math.round(Math.min(800, Math.max(0, x)) * 10) / 10;
  const py = Math.round(Math.min(560, Math.max(0, y)) * 10) / 10;
  let points = Array.isArray(src.points) ? src.points.map(readPoint) : null;
  if (points && points.some((point) => !point)) return fail("Area points must be coordinates");
  if (shape === "outline") {
    if (!points || points.length < 3) return fail("An outline needs at least three points");
  } else if (!points || !points.length) {
    points = [{ x: px, y: py }];
  }
  const selfId = existing ? Number(existing.area_id) : null;
  const routes = uniqueIds(parseIdList(src.routes != null ? src.routes : src.sys_links != null ? src.sys_links : existing && existing.routes));
  const filtered = routes.filter((id) => id !== selfId);
  if (knownIds) {
    for (const id of filtered) {
      if (!knownIds.has(id)) return fail("A route points at an area that is not on the map");
    }
  }
  const tables = normalizeTables(src.tables != null ? src.tables : existing && existing.tables);
  let scenario = src.scenario != null ? src.scenario : existing && existing.scenario;
  scenario = scenario == null || scenario === "" ? null : clip(scenario, 80);
  if (scenario === "") scenario = null;
  const notes = clip(src.notes != null ? src.notes : src.sys_notes != null ? src.sys_notes : existing && existing.notes, 500);
  return pass({
    area_id: selfId,
    name,
    shape,
    points,
    x: px,
    y: py,
    routes: filtered,
    tables,
    scenario,
    notes
  });
}

function validateImage(image) {
  if (image == null) return pass(null);
  if (typeof image !== "object" || Array.isArray(image)) return fail("Map image must be a file reference");
  const file = clip(image.file, 120);
  if (!file) return pass(null);
  if (file !== pathBasename(file) || file.startsWith(".")) return fail("Map image must be a file name");
  const out = { file };
  if (image.width != null && image.width !== "") {
    const width = Number(image.width);
    if (!Number.isInteger(width) || width < 1) return fail("Map image width must be a positive integer");
    out.width = width;
  }
  if (image.height != null && image.height !== "") {
    const height = Number(image.height);
    if (!Number.isInteger(height) || height < 1) return fail("Map image height must be a positive integer");
    out.height = height;
  }
  return pass(out);
}

function pathBasename(file) {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash >= 0 ? file.slice(slash + 1) : file;
}

function forbiddenPlayerKey(body) {
  if (!body || typeof body !== "object") return null;
  for (const key of FORBIDDEN_PLAYER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] != null && body[key] !== "") {
      return key;
    }
  }
  return null;
}

function validatePlayer(body, existing) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Player must be an object");
  const blocked = forbiddenPlayerKey(src);
  if (blocked) return fail("Entrants are stored by display name and an optional army. Contact details are not stored");
  const display = clip(src.display_name != null ? src.display_name : existing && existing.display_name, 40);
  if (!display) return fail("Display name is required");
  const faction = src.faction || (existing && existing.faction);
  if (!FACTIONS.includes(faction)) return fail("Faction must be Loyalist or Traitor");
  const dropped = src.dropped != null ? !!src.dropped : !!(existing && existing.dropped);
  const bye = src.bye != null ? !!src.bye : !!(existing && existing.bye);
  const armySource = src.army != null ? src.army : existing && existing.army;
  const army = armySource == null || armySource === "" ? null : clip(armySource, 80);
  return pass({
    player_id: existing ? existing.player_id : null,
    display_name: display,
    faction,
    army,
    dropped,
    bye
  });
}

function publicEntrant(player) {
  return {
    player_id: player.player_id,
    display_name: player.display_name,
    faction: player.faction,
    army: player.army || null,
    dropped: !!player.dropped
  };
}

function validateRound(body, existing, event) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Round must be an object");
  const planned = event && event.rounds_planned ? event.rounds_planned : 5;
  const number = Number(src.number != null ? src.number : existing && existing.number);
  if (!Number.isInteger(number) || number < 1 || number > planned) {
    return fail("Round number must be from 1 to " + planned);
  }
  const state = src.state || (existing && existing.state) || "draft";
  const stateError = nextRecordState(existing && existing.state, state);
  if (stateError) return fail(stateError);
  return pass({
    round_id: existing ? existing.round_id : null,
    number,
    state,
    qr_token: (existing && existing.qr_token) || generateQrToken()
  });
}

function publicRound(round) {
  return { round_id: round.round_id, number: round.number, state: round.state };
}

function nextRecordState(previous, requested) {
  if (!RECORD_STATES.includes(requested)) return "State must be draft, approved, or published";
  if (!previous) {
    if (requested === "published") return "Approve a record before it is published";
    return null;
  }
  if (requested === previous) return null;
  if (previous === "draft" && requested === "published") return "Approve a record before it is published";
  if (previous === "published" && requested === "draft") return "A published record cannot return to draft";
  return null;
}

function playerById(players, id) {
  return (players || []).find((player) => Number(player.player_id) === Number(id)) || null;
}

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? x + ":" + y : y + ":" + x;
}

function findRematch(pairings, loyalistId, traitorId, exceptId) {
  if (!loyalistId || !traitorId) return null;
  const key = pairKey(loyalistId, traitorId);
  return (pairings || []).find((pairing) => {
    if (exceptId != null && Number(pairing.pairing_id) === Number(exceptId)) return false;
    if (pairing.kind === "bye") return false;
    if (!pairing.loyalist_id || !pairing.traitor_id) return false;
    return pairKey(pairing.loyalist_id, pairing.traitor_id) === key;
  });
}

function validatePairing(body, existing, context) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Pairing must be an object");
  const ctx = context || {};
  const kind = src.kind || (existing && existing.kind);
  if (!PAIRING_KINDS.includes(kind)) return fail("Pairing kind must be normal, apex, grudge, or bye");
  const locked = kind === "apex" || kind === "grudge" ? true : src.locked != null ? !!src.locked : !!(existing && existing.locked);
  if ((kind === "apex" || kind === "grudge") && src.locked === false) {
    return fail("Apex and grudge matches stay locked");
  }
  const state = src.state || (existing && existing.state) || "draft";
  const stateError = nextRecordState(existing && existing.state, state);
  if (stateError) return fail(stateError);
  const roundId = Number(src.round_id != null ? src.round_id : existing && existing.round_id);
  if (!Number.isInteger(roundId) || roundId < 1) return fail("Pairing needs a round");
  if (ctx.rounds && !ctx.rounds.some((round) => Number(round.round_id) === roundId)) {
    return fail("Round not found");
  }
  let areaId = src.area_id != null && src.area_id !== "" ? Number(src.area_id) : existing && existing.area_id != null ? existing.area_id : null;
  if (areaId != null && !Number.isInteger(Number(areaId))) return fail("Area is not valid");
  areaId = areaId == null ? null : Number(areaId);
  if (areaId && ctx.areas && !ctx.areas.some((area) => Number(area.area_id) === areaId)) {
    return fail("Area not found");
  }
  const tableRaw = src.table != null ? src.table : existing && existing.table;
  const table = tableRaw == null || tableRaw === "" ? null : clip(tableRaw, 16);
  let loyalistId = src.loyalist_id != null && src.loyalist_id !== "" ? Number(src.loyalist_id) : kind === "bye" && src.loyalist_id === null ? null : existing ? existing.loyalist_id : null;
  let traitorId = src.traitor_id != null && src.traitor_id !== "" ? Number(src.traitor_id) : kind === "bye" && src.traitor_id === null ? null : existing ? existing.traitor_id : null;
  if (loyalistId != null) loyalistId = Number(loyalistId);
  if (traitorId != null) traitorId = Number(traitorId);
  if (kind === "bye") {
    const present = [loyalistId, traitorId].filter((id) => id);
    if (present.length !== 1) return fail("A bye pairing names one player");
  } else {
    if (!loyalistId || !traitorId) return fail("A game needs a Loyalist and a Traitor");
    if (loyalistId === traitorId) return fail("A player cannot be paired with themselves");
  }
  const players = ctx.players || [];
  if (loyalistId) {
    const player = playerById(players, loyalistId);
    if (ctx.players && !player) return fail("Loyalist entrant not found");
    if (player && player.faction !== "Loyalist") return fail("The Loyalist seat must be a Loyalist entrant");
    if (player && player.dropped) return fail("A dropped entrant cannot be paired");
  }
  if (traitorId) {
    const player = playerById(players, traitorId);
    if (ctx.players && !player) return fail("Traitor entrant not found");
    if (player && player.faction !== "Traitor") return fail("The Traitor seat must be a Traitor entrant");
    if (player && player.dropped) return fail("A dropped entrant cannot be paired");
  }
  if (kind !== "bye" && findRematch(ctx.pairings || [], loyalistId, traitorId, existing && existing.pairing_id)) {
    return fail("Those two entrants have already been paired");
  }
  return pass({
    pairing_id: existing ? existing.pairing_id : null,
    round_id: roundId,
    table,
    area_id: areaId,
    kind,
    locked,
    state,
    loyalist_id: loyalistId || null,
    traitor_id: traitorId || null
  });
}

function publicPairing(pairing) {
  if (!pairing || pairing.state !== "published") return null;
  return {
    pairing_id: pairing.pairing_id,
    round_id: pairing.round_id,
    table: pairing.table,
    area_id: pairing.area_id,
    kind: pairing.kind,
    locked: !!pairing.locked,
    state: pairing.state,
    loyalist_id: pairing.loyalist_id,
    traitor_id: pairing.traitor_id
  };
}

function parseVp(value) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value === "boolean") return { ok: false };
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return { ok: false };
    return { ok: true, value };
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) {
    return { ok: true, value: Number(value.trim()) };
  }
  return { ok: false };
}

function outcomeFromScores(loyalistVp, traitorVp) {
  if (loyalistVp == null || traitorVp == null) return null;
  if (loyalistVp > traitorVp) return "loyalist_win";
  if (traitorVp > loyalistVp) return "traitor_win";
  return "tie";
}

function campaignPoints(result) {
  if (!result) return { loyalist: 0, traitor: 0 };
  if (result.outcome === "loyalist_win") return { loyalist: SCORING.win, traitor: SCORING.loss };
  if (result.outcome === "traitor_win") return { loyalist: SCORING.loss, traitor: SCORING.win };
  if (result.outcome === "tie") return { loyalist: SCORING.tie, traitor: SCORING.tie };
  if (result.outcome === "bye") {
    if (result.loyalist_vp != null && result.traitor_vp == null) return { loyalist: SCORING.win, traitor: SCORING.loss };
    if (result.traitor_vp != null && result.loyalist_vp == null) return { loyalist: SCORING.loss, traitor: SCORING.win };
  }
  return { loyalist: 0, traitor: 0 };
}

function validateResult(body, existing, context) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Result must be an object");
  const ctx = context || {};
  const pairingId = Number(src.pairing_id != null ? src.pairing_id : existing && existing.pairing_id);
  if (!Number.isInteger(pairingId) || pairingId < 1) return fail("Result needs a pairing");
  const pairing = (ctx.pairings || []).find((row) => Number(row.pairing_id) === pairingId);
  if (ctx.pairings && !pairing) return fail("Pairing not found");
  const roundId = Number(src.round_id != null ? src.round_id : pairing ? pairing.round_id : existing && existing.round_id);
  if (pairing && Number(pairing.round_id) !== roundId) return fail("Result round does not match the pairing");
  const loyal = parseVp(src.loyalist_vp != null ? src.loyalist_vp : existing && existing.loyalist_vp);
  const traitor = parseVp(src.traitor_vp != null ? src.traitor_vp : existing && existing.traitor_vp);
  if (!loyal.ok || !traitor.ok) return fail("Victory points must be a non-negative integer");
  let outcome = src.outcome || (existing && existing.outcome);
  const byeVp = (ctx.event && ctx.event.scoring && ctx.event.scoring.bye_vp) || SCORING.bye_vp;
  if (pairing && pairing.kind === "bye") {
    outcome = "bye";
    const sideVp = pairing.loyalist_id ? loyal.value : traitor.value;
    const other = pairing.loyalist_id ? traitor.value : loyal.value;
    if (other != null) return fail("A bye records VP for one player");
    if (sideVp == null || sideVp < byeVp) return fail("A bye is a win worth at least " + byeVp + " VP");
  } else {
    const expected = outcomeFromScores(loyal.value, traitor.value);
    if (!expected) return fail("Both victory point totals are required");
    if (outcome && outcome !== expected) return fail("Outcome does not match the victory points");
    outcome = expected;
  }
  if (!OUTCOMES.includes(outcome)) return fail("Outcome is not valid");
  let confirmation = src.confirmation || (existing && existing.confirmation) || (outcome === "bye" ? "confirmed" : "pending");
  if (!CONFIRMATIONS.includes(confirmation)) return fail("Confirmation must be pending, confirmed, or disputed");
  let reportedBy = src.reported_by != null ? src.reported_by : existing && existing.reported_by;
  if (reportedBy === "") reportedBy = null;
  if (reportedBy && !REPORTED_BY.includes(reportedBy)) return fail("Reported-by is not valid");
  if (!reportedBy && confirmation === "pending") reportedBy = "admin";
  let confirmedBy = src.confirmed_by != null ? src.confirmed_by : existing && existing.confirmed_by;
  if (confirmation !== "confirmed") confirmedBy = null;
  else if (outcome === "bye" && !confirmedBy) confirmedBy = "admin";
  if (confirmation === "confirmed") {
    if (!CONFIRMED_BY.includes(confirmedBy)) return fail("A confirmed result says who confirmed it");
    if (confirmedBy === "opponent" && reportedBy !== "loyalist" && reportedBy !== "traitor") {
      return fail("Opponent confirmation needs a result reported by one side");
    }
  }
  const value = {
    result_id: existing ? existing.result_id : null,
    pairing_id: pairingId,
    round_id: roundId,
    loyalist_vp: loyal.value,
    traitor_vp: traitor.value,
    outcome,
    confirmation,
    reported_by: reportedBy || null,
    confirmed_by: confirmedBy || null
  };
  value.campaign_points = campaignPoints(value);
  return pass(value);
}

function withCampaignPoints(result) {
  return { ...result, campaign_points: campaignPoints(result) };
}

function nextController(previous, loyalistPoints, traitorPoints) {
  const loyal = Number(loyalistPoints) || 0;
  const traitor = Number(traitorPoints) || 0;
  if (loyal > traitor) return "Loyalist";
  if (traitor > loyal) return "Traitor";
  if (previous === "Loyalist" || previous === "Traitor") return previous;
  return "neutral";
}

function roundNumber(rounds, roundId) {
  const round = (rounds || []).find((row) => Number(row.round_id) === Number(roundId));
  return round && round.number != null ? Number(round.number) : Number(roundId);
}

function priorControl(history, areaId, roundId, rounds) {
  const current = roundNumber(rounds, roundId);
  const rows = (history || []).filter((row) => {
    if (Number(row.area_id) !== Number(areaId)) return false;
    return roundNumber(rounds, row.round_id) < current;
  });
  rows.sort((a, b) => roundNumber(rounds, a.round_id) - roundNumber(rounds, b.round_id));
  return rows.length ? rows[rows.length - 1] : null;
}

function validateControl(body, context) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return fail("Control record must be an object");
  const roundId = Number(src.round_id);
  const areaId = Number(src.area_id);
  if (!Number.isInteger(roundId) || roundId < 1) return fail("Control record needs a round");
  if (!Number.isInteger(areaId) || areaId < 1) return fail("Control record needs an area");
  const ctx = context || {};
  if (ctx.rounds && !ctx.rounds.some((round) => Number(round.round_id) === roundId)) return fail("Round not found");
  if (ctx.areas && !ctx.areas.some((area) => Number(area.area_id) === areaId)) return fail("Area not found");
  const loyal = Number(src.loyalist_points);
  const traitor = Number(src.traitor_points);
  if (!Number.isInteger(loyal) || loyal < 0 || !Number.isInteger(traitor) || traitor < 0) {
    return fail("Area points must be non-negative integers");
  }
  const prior = priorControl(ctx.control, areaId, roundId, ctx.rounds);
  const previous = prior ? prior.controller : src.previous_controller || "neutral";
  if (!CONTROLLERS.includes(previous)) return fail("Previous holder must be Loyalist, Traitor, or neutral");
  if (src.previous_controller && src.previous_controller !== previous) {
    return fail("Previous holder does not match the last round");
  }
  const expected = nextController(previous, loyal, traitor);
  if (src.controller && src.controller !== expected) {
    return fail("Area control does not match this round's points and the previous holder");
  }
  return pass({
    round_id: roundId,
    area_id: areaId,
    loyalist_points: loyal,
    traitor_points: traitor,
    previous_controller: previous,
    controller: expected
  });
}

function validateAreaSet(areas) {
  if (!Array.isArray(areas)) return fail("Areas must be a list");
  const staged = [];
  const used = new Set();
  let next = 1;
  for (const raw of areas) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Each area must be an object");
    let id = raw.area_id != null && raw.area_id !== "" ? Number(raw.area_id) : null;
    if (id == null) {
      while (used.has(next)) next += 1;
      id = next;
      next += 1;
    }
    if (!Number.isInteger(id) || id < 1 || used.has(id)) return fail("Area ids must be unique positive integers");
    used.add(id);
    staged.push({ raw, id });
  }
  const out = [];
  for (const item of staged) {
    const checked = validateArea({ ...item.raw, area_id: item.id }, { area_id: item.id }, used);
    if (!checked.ok) return checked;
    checked.value.area_id = item.id;
    checked.value.routes = checked.value.routes.filter((routeId) => routeId !== item.id);
    out.push(checked.value);
  }
  return pass(out);
}

function currentAreaController(areaId, control, rounds) {
  const rows = (control || []).filter((row) => Number(row.area_id) === Number(areaId));
  if (!rows.length) return "neutral";
  rows.sort((a, b) => roundNumber(rounds, a.round_id) - roundNumber(rounds, b.round_id));
  const controller = rows[rows.length - 1].controller;
  return CONTROLLERS.includes(controller) ? controller : "neutral";
}

function factionLeader(controllers, campaignPoints) {
  let loyal = 0;
  let traitor = 0;
  (controllers || []).forEach((controller) => {
    if (controller === "Loyalist") loyal += 1;
    else if (controller === "Traitor") traitor += 1;
  });
  if (loyal > traitor) return "Loyalist";
  if (traitor > loyal) return "Traitor";
  const points = campaignPoints || {};
  const loyalPoints = Number(points.loyalist) || 0;
  const traitorPoints = Number(points.traitor) || 0;
  if (loyalPoints > traitorPoints) return "Loyalist";
  if (traitorPoints > loyalPoints) return "Traitor";
  return null;
}

function compareStandings(a, b) {
  for (const key of TIEBREAKERS) {
    const diff = Number(b[key] || 0) - Number(a[key] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestGenerals(players, rowsById) {
  const out = { loyalist: null, traitor: null };
  (players || []).forEach((player) => {
    const row = rowsById && rowsById[player.player_id];
    if (!row) return;
    const seat = player.faction === "Loyalist" ? "loyalist" : player.faction === "Traitor" ? "traitor" : null;
    if (!seat) return;
    const current = out[seat];
    if (!current || compareStandings(row, current.row) < 0) out[seat] = { player_id: player.player_id, row };
  });
  return {
    loyalist: out.loyalist ? out.loyalist.player_id : null,
    traitor: out.traitor ? out.traitor.player_id : null
  };
}

module.exports = {
  FACTIONS,
  PAIRING_KINDS,
  RECORD_STATES,
  CONFIRMATIONS,
  OUTCOMES,
  SHAPES,
  CONTROLLERS,
  SCORING,
  TIEBREAKERS,
  CONTROL_TIE,
  CANONICAL_ADMIN_ROLE,
  FORBIDDEN_PLAYER_KEYS,
  isAdminRole,
  normalizeAdminRole,
  generateEventCode,
  generateQrToken,
  defaultEvent,
  validateEvent,
  publicEvent,
  areaFromSystem,
  systemFromArea,
  mergeSystemEdit,
  validateArea,
  validateAreaSet,
  validateImage,
  currentAreaController,
  validatePlayer,
  publicEntrant,
  validateRound,
  publicRound,
  validatePairing,
  publicPairing,
  findRematch,
  validateResult,
  campaignPoints,
  withCampaignPoints,
  outcomeFromScores,
  nextController,
  validateControl,
  factionLeader,
  compareStandings,
  bestGenerals
};
