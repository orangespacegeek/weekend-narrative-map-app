/**
 * Swiss pairing for one round.
 *
 * Loyalist vs Traitor only. Locked Apex and Grudge matches are left in place.
 * Dropped entrants are skipped. Stand-in entrants are not counted in either
 * side. When the real sides are uneven, each extra player on the larger side
 * is paired with a TO stand-in on the smaller side. An existing stand-in who
 * has not already played that person is used first. Otherwise a new stand-in
 * slot is created. The game goes to the lowest-ranked eligible player on the
 * larger side who has not played a stand-in yet. Those matches are normal
 * games, not byes. A bye is only recorded when the organiser assigns one.
 *
 * Pairing prefers the closest ranks and backtracks to avoid a rematch. If no
 * rematch-free pairing exists, nothing is paired and the caller must tell the
 * organiser. The same inputs and seed always produce the same pairs.
 */
"use strict";

const { SCORING, campaignPoints, compareStandings } = require("./model");

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? x + ":" + y : y + ":" + x;
}

function tieKey(playerId, seed) {
  if (seed == null || seed === "") return Number(playerId) || 0;
  let x = ((Number(seed) || 0) ^ (Number(playerId) || 0) ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

function scoreEvent(players, pairings, results) {
  const rows = {};
  (players || []).forEach((player) => {
    rows[player.player_id] = {
      player_id: player.player_id,
      faction: player.faction,
      campaign_points: 0,
      vp_for: 0,
      vp_against: 0,
      vp_diff: 0,
      opponents: [],
      had_bye: false,
      strength_of_schedule: 0
    };
  });
  const pairingById = new Map((pairings || []).map((pairing) => [Number(pairing.pairing_id), pairing]));
  (pairings || []).forEach((pairing) => {
    if (pairing.kind !== "bye") return;
    const id = pairing.loyalist_id || pairing.traitor_id;
    if (rows[id]) rows[id].had_bye = true;
  });
  (results || []).forEach((result) => {
    if (!result || result.confirmation === "disputed") return;
    const pairing = pairingById.get(Number(result.pairing_id));
    if (!pairing) return;
    const points = campaignPoints(result);
    if (result.outcome === "bye") {
      if (pairing.loyalist_id && result.loyalist_vp != null && rows[pairing.loyalist_id]) {
        rows[pairing.loyalist_id].campaign_points += points.loyalist;
        rows[pairing.loyalist_id].vp_for += result.loyalist_vp;
        rows[pairing.loyalist_id].had_bye = true;
      }
      if (pairing.traitor_id && result.traitor_vp != null && rows[pairing.traitor_id]) {
        rows[pairing.traitor_id].campaign_points += points.traitor;
        rows[pairing.traitor_id].vp_for += result.traitor_vp;
        rows[pairing.traitor_id].had_bye = true;
      }
      return;
    }
    const lvp = Number(result.loyalist_vp) || 0;
    const tvp = Number(result.traitor_vp) || 0;
    if (pairing.loyalist_id && rows[pairing.loyalist_id]) {
      const row = rows[pairing.loyalist_id];
      row.campaign_points += points.loyalist;
      row.vp_for += lvp;
      row.vp_against += tvp;
      if (pairing.traitor_id) row.opponents.push(pairing.traitor_id);
    }
    if (pairing.traitor_id && rows[pairing.traitor_id]) {
      const row = rows[pairing.traitor_id];
      row.campaign_points += points.traitor;
      row.vp_for += tvp;
      row.vp_against += lvp;
      if (pairing.loyalist_id) row.opponents.push(pairing.loyalist_id);
    }
  });
  Object.values(rows).forEach((row) => {
    row.vp_diff = row.vp_for - row.vp_against;
    row.strength_of_schedule = row.opponents.reduce((sum, id) => sum + (rows[id] ? rows[id].campaign_points : 0), 0);
  });
  return rows;
}

function rankPlayers(players, scores, seed) {
  return players.slice().sort((a, b) => {
    const diff = compareStandings(scores[a.player_id], scores[b.player_id]);
    if (diff) return diff;
    return tieKey(a.player_id, seed) - tieKey(b.player_id, seed);
  });
}

function playersById(players) {
  const byId = {};
  (players || []).forEach((player) => {
    byId[Number(player.player_id)] = player;
  });
  return byId;
}

function playedStandIn(player, pairings, byId) {
  const id = Number(player.player_id);
  return (pairings || []).some((pairing) => {
    if (pairing.kind === "bye" || !pairing.loyalist_id || !pairing.traitor_id) return false;
    const opponent = Number(pairing.loyalist_id) === id ? Number(pairing.traitor_id)
      : Number(pairing.traitor_id) === id ? Number(pairing.loyalist_id) : 0;
    if (!opponent) return false;
    const other = byId[opponent];
    return !!(other && other.is_stand_in);
  });
}

function pickStandInRecipients(side, count, pairings, byId) {
  const warnings = [];
  const lowFirst = side.slice().reverse();
  const fresh = lowFirst.filter((player) => !playedStandIn(player, pairings, byId));
  const repeat = lowFirst.filter((player) => playedStandIn(player, pairings, byId));
  if (fresh.length < count) {
    warnings.push("Every eligible player on the larger side has already played a TO stand-in. Extra stand-in games go to the lowest ranked.");
  }
  const chosen = fresh.concat(repeat).slice(0, count);
  const ids = new Set(chosen.map((player) => player.player_id));
  return { chosen, rest: side.filter((player) => !ids.has(player.player_id)), warnings };
}

function autoStandInNumber(name) {
  const match = /^to stand-in(?: (\d+))?$/i.exec(String(name || "").trim());
  if (!match) return 0;
  return match[1] ? Number(match[1]) : 1;
}

function makeAutoStandIn(roster, faction) {
  const used = roster.reduce((max, player) => Math.max(max, autoStandInNumber(player.display_name)), 0);
  const n = used + 1;
  const player = {
    player_id: roster.reduce((max, row) => Math.max(max, Number(row.player_id) || 0), 0) + 1,
    display_name: n === 1 ? "TO Stand-in" : "TO Stand-in " + n,
    faction,
    army: null,
    dropped: false,
    bye: false,
    is_stand_in: true
  };
  roster.push(player);
  return player;
}

function pairWithStandIns(recipients, pool, played, roster, created) {
  const pairs = [];
  recipients.forEach((player) => {
    const available = pool
      .filter((standIn) => !played.has(pairKey(player.player_id, standIn.player_id)))
      .sort((a, b) => Number(a.player_id) - Number(b.player_id));
    let opponent = available[0];
    if (opponent) {
      pool.splice(pool.indexOf(opponent), 1);
    } else {
      opponent = makeAutoStandIn(roster, player.faction === "Loyalist" ? "Traitor" : "Loyalist");
      created.push(opponent);
    }
    played.add(pairKey(player.player_id, opponent.player_id));
    pairs.push(player.faction === "Loyalist" ? [player, opponent] : [opponent, player]);
  });
  return pairs;
}

function swissPairs(loyalists, traitors, played) {
  const used = new Array(traitors.length).fill(false);
  const pairs = [];
  function walk(index) {
    if (index === loyalists.length) return true;
    const loyalist = loyalists[index];
    for (let i = 0; i < traitors.length; i++) {
      if (used[i]) continue;
      const traitor = traitors[i];
      if (played.has(pairKey(loyalist.player_id, traitor.player_id))) continue;
      used[i] = true;
      pairs.push([loyalist, traitor]);
      if (walk(index + 1)) return true;
      pairs.pop();
      used[i] = false;
    }
    return false;
  }
  if (!walk(0)) return null;
  return pairs;
}

function generateSwiss(input) {
  const players = input.players || [];
  const pairings = input.pairings || [];
  const results = input.results || [];
  const roundId = Number(input.roundId);
  const byId = playersById(players);
  const scores = scoreEvent(players, pairings, results);
  const locked = pairings.filter((pairing) => {
    return Number(pairing.round_id) === roundId && (pairing.kind === "apex" || pairing.kind === "grudge");
  });
  const seated = new Set();
  locked.forEach((pairing) => {
    if (pairing.loyalist_id) seated.add(Number(pairing.loyalist_id));
    if (pairing.traitor_id) seated.add(Number(pairing.traitor_id));
  });
  const eligible = players.filter((player) => !player.dropped && !seated.has(Number(player.player_id)));
  let loyalists = rankPlayers(eligible.filter((player) => player.faction === "Loyalist" && !player.is_stand_in), scores, input.seed);
  let traitors = rankPlayers(eligible.filter((player) => player.faction === "Traitor" && !player.is_stand_in), scores, input.seed);
  const warnings = [];
  const createdPlayers = [];
  const roster = players.slice();
  const played = new Set();
  pairings.forEach((pairing) => {
    if (!pairing.loyalist_id || !pairing.traitor_id || pairing.kind === "bye") return;
    played.add(pairKey(pairing.loyalist_id, pairing.traitor_id));
  });
  const standInPairs = [];
  const extraLoyal = loyalists.length - traitors.length;
  if (extraLoyal > 0) {
    const assigned = pickStandInRecipients(loyalists, extraLoyal, pairings, byId);
    loyalists = assigned.rest;
    warnings.push(...assigned.warnings);
    const pool = eligible.filter((player) => player.faction === "Traitor" && player.is_stand_in);
    standInPairs.push(...pairWithStandIns(assigned.chosen, pool, played, roster, createdPlayers));
  } else if (extraLoyal < 0) {
    const assigned = pickStandInRecipients(traitors, -extraLoyal, pairings, byId);
    traitors = assigned.rest;
    warnings.push(...assigned.warnings);
    const pool = eligible.filter((player) => player.faction === "Loyalist" && player.is_stand_in);
    standInPairs.push(...pairWithStandIns(assigned.chosen, pool, played, roster, createdPlayers));
  }
  const pairs = swissPairs(loyalists, traitors, played);
  const standings = Object.values(scores).sort(compareStandings);
  if (!pairs) {
    return {
      ok: false,
      error: "No pairing without a rematch. Nothing was changed.",
      warnings,
      standings
    };
  }
  return {
    ok: true,
    pairs: standInPairs.concat(pairs),
    byes: [],
    createdPlayers,
    warnings,
    standings,
    bye_vp: SCORING.bye_vp
  };
}

module.exports = { scoreEvent, generateSwiss, pairKey, tieKey };
