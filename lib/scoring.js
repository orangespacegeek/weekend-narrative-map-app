/**
 * Standings, area control, and the narrative log.
 * Only confirmed results on published pairings count.
 */
"use strict";

const { SCORING, campaignPoints, compareStandings, nextController } = require("./model");

function publishedPairings(pairings) {
  const byRound = new Map();
  (pairings || []).forEach((pairing) => {
    const key = Number(pairing.round_id);
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(pairing);
  });
  const open = new Set();
  byRound.forEach((rows, roundId) => {
    if (rows.length && rows.every((pairing) => pairing.state === "published")) open.add(roundId);
  });
  return (pairings || []).filter((pairing) => open.has(Number(pairing.round_id)));
}

function confirmedResults(results, pairings) {
  const ids = new Set(pairings.map((pairing) => Number(pairing.pairing_id)));
  return (results || []).filter((result) => result && result.confirmation === "confirmed" && ids.has(Number(result.pairing_id)));
}

function person(players, id) {
  const player = (players || []).find((row) => Number(row.player_id) === Number(id));
  if (!player) return null;
  return { display_name: player.display_name, faction: player.faction, army: player.army || null };
}

function scorePlayers(players, pairings, results) {
  const rows = {};
  (players || []).forEach((player) => {
    rows[player.player_id] = {
      player_id: player.player_id,
      display_name: player.display_name,
      faction: player.faction,
      army: player.army || null,
      campaign_points: 0,
      vp_for: 0,
      vp_against: 0,
      vp_diff: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      opponents: [],
      strength_of_schedule: 0
    };
  });
  const pairingById = new Map(pairings.map((pairing) => [Number(pairing.pairing_id), pairing]));
  results.forEach((result) => {
    const pairing = pairingById.get(Number(result.pairing_id));
    if (!pairing) return;
    const points = campaignPoints(result);
    if (result.outcome === "bye") {
      const id = pairing.loyalist_id || pairing.traitor_id;
      const row = rows[id];
      if (!row) return;
      const vp = pairing.loyalist_id ? result.loyalist_vp : result.traitor_vp;
      row.campaign_points += pairing.loyalist_id ? points.loyalist : points.traitor;
      row.vp_for += Number(vp) || 0;
      row.wins += 1;
      return;
    }
    const lvp = Number(result.loyalist_vp) || 0;
    const tvp = Number(result.traitor_vp) || 0;
    if (pairing.loyalist_id && rows[pairing.loyalist_id]) {
      const row = rows[pairing.loyalist_id];
      row.campaign_points += points.loyalist;
      row.vp_for += lvp;
      row.vp_against += tvp;
      if (result.outcome === "loyalist_win") row.wins += 1;
      else if (result.outcome === "traitor_win") row.losses += 1;
      else row.ties += 1;
      if (pairing.traitor_id) row.opponents.push(pairing.traitor_id);
    }
    if (pairing.traitor_id && rows[pairing.traitor_id]) {
      const row = rows[pairing.traitor_id];
      row.campaign_points += points.traitor;
      row.vp_for += tvp;
      row.vp_against += lvp;
      if (result.outcome === "traitor_win") row.wins += 1;
      else if (result.outcome === "loyalist_win") row.losses += 1;
      else row.ties += 1;
      if (pairing.loyalist_id) row.opponents.push(pairing.loyalist_id);
    }
  });
  Object.values(rows).forEach((row) => {
    row.vp_diff = row.vp_for - row.vp_against;
    row.strength_of_schedule = row.opponents.reduce((sum, id) => sum + (rows[id] ? rows[id].campaign_points : 0), 0);
  });
  return rows;
}

function ranked(players, rows, faction) {
  return (players || [])
    .filter((player) => player.faction === faction)
    .map((player) => rows[player.player_id])
    .filter(Boolean)
    .sort((a, b) => {
      const diff = compareStandings(a, b);
      if (diff) return diff;
      return String(a.display_name).localeCompare(String(b.display_name));
    })
    .map((row, index) => ({
      rank: index + 1,
      display_name: row.display_name,
      army: row.army,
      wins: row.wins,
      losses: row.losses,
      ties: row.ties,
      campaign_points: row.campaign_points,
      vp_diff: row.vp_diff,
      strength_of_schedule: row.strength_of_schedule
    }));
}

function controlReason(previous, loyal, traitor, controller) {
  if (loyal > traitor) return "Loyalist scored more campaign points this round";
  if (traitor > loyal) return "Traitor scored more campaign points this round";
  if (previous === "Loyalist" || previous === "Traitor") return "The round was tied, so the previous holder keeps it";
  return "The round was tied, and nobody held it";
}

function areaHistory(areas, rounds, pairings, results) {
  const holders = {};
  const history = [];
  const ordered = (rounds || []).slice().sort((a, b) => Number(a.number) - Number(b.number));
  ordered.forEach((round) => {
    const inRound = pairings.filter((pairing) => Number(pairing.round_id) === Number(round.round_id));
    if (!inRound.length) return;
    (areas || []).forEach((area) => {
      let loyal = 0;
      let traitor = 0;
      results.forEach((result) => {
        const pairing = inRound.find((row) => Number(row.pairing_id) === Number(result.pairing_id));
        if (!pairing || Number(pairing.area_id) !== Number(area.area_id)) return;
        const points = campaignPoints(result);
        loyal += points.loyalist;
        traitor += points.traitor;
      });
      const previous = holders[area.area_id] || "neutral";
      const controller = nextController(previous, loyal, traitor);
      holders[area.area_id] = controller;
      history.push({
        round_id: round.round_id,
        number: round.number,
        area_id: area.area_id,
        name: area.name,
        loyalist_points: loyal,
        traitor_points: traitor,
        previous_controller: previous,
        controller,
        reason: controlReason(previous, loyal, traitor, controller)
      });
    });
  });
  return { history, holders };
}

function factionTotals(rows) {
  const totals = { Loyalist: 0, Traitor: 0 };
  Object.values(rows).forEach((row) => {
    if (totals[row.faction] != null) totals[row.faction] += row.campaign_points;
  });
  return totals;
}

function areaCounts(areas, holders) {
  const counts = { Loyalist: 0, Traitor: 0, neutral: 0 };
  (areas || []).forEach((area) => {
    const holder = holders[area.area_id] || "neutral";
    if (counts[holder] != null) counts[holder] += 1;
    else counts.neutral += 1;
  });
  return counts;
}

function leaderFrom(counts, totals) {
  if (counts.Loyalist > counts.Traitor) return "Loyalist";
  if (counts.Traitor > counts.Loyalist) return "Traitor";
  if (totals.Loyalist > totals.Traitor) return "Loyalist";
  if (totals.Traitor > totals.Loyalist) return "Traitor";
  return null;
}

function battleView(pairing, result, players, areas) {
  const area = (areas || []).find((item) => Number(item.area_id) === Number(pairing.area_id));
  return {
    kind: pairing.kind,
    table: pairing.table || null,
    area: area ? area.name : null,
    loyalist: person(players, pairing.loyalist_id),
    traitor: person(players, pairing.traitor_id),
    outcome: result.outcome,
    loyalist_vp: result.loyalist_vp,
    traitor_vp: result.traitor_vp,
    note: result.note || null
  };
}

function noteView(pairing, result, players) {
  if (!result.note) return null;
  const seat = result.reported_by === "traitor" ? pairing.traitor_id : pairing.loyalist_id;
  const who = person(players, seat) || person(players, pairing.loyalist_id) || person(players, pairing.traitor_id);
  if (!who) return null;
  return {
    display_name: who.display_name,
    faction: who.faction,
    army: who.army,
    note: result.note,
    table: pairing.table || null,
    kind: pairing.kind
  };
}

function scoreState(input) {
  const players = input.players || [];
  const rounds = input.rounds || [];
  const areas = input.areas || [];
  const livePairs = publishedPairings(input.pairings || []);
  const liveResults = confirmedResults(input.results || [], livePairs);
  const rows = scorePlayers(players, livePairs, liveResults);
  const { history, holders } = areaHistory(areas, rounds, livePairs, liveResults);
  const totals = factionTotals(rows);
  const counts = areaCounts(areas, holders);
  const leader = leaderFrom(counts, totals);
  const planned = input.roundsPlanned || rounds.length || 0;
  const publishedRounds = new Set(livePairs.map((pairing) => Number(pairing.round_id)));
  const complete = planned > 0 && publishedRounds.size >= planned;
  const blurbs = new Map((input.blurbs || []).map((row) => [Number(row.round_id), row.blurb]));
  const pairingById = new Map(livePairs.map((pairing) => [Number(pairing.pairing_id), pairing]));
  const log = rounds
    .filter((round) => publishedRounds.has(Number(round.round_id)))
    .slice()
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((round) => {
      const areasThisRound = history.filter((row) => Number(row.round_id) === Number(round.round_id));
      const resultsThisRound = liveResults.filter((result) => Number(result.round_id) === Number(round.round_id));
      const battles = [];
      const notes = [];
      resultsThisRound.forEach((result) => {
        const pairing = pairingById.get(Number(result.pairing_id));
        if (!pairing || pairing.kind === "bye") {
          const note = pairing ? noteView(pairing, result, players) : null;
          if (note) notes.push(note);
          return;
        }
        if (pairing.kind === "apex" || pairing.kind === "grudge") battles.push(battleView(pairing, result, players, areas));
        const note = noteView(pairing, result, players);
        if (note) notes.push(note);
      });
      return {
        round_id: round.round_id,
        number: round.number,
        blurb: blurbs.get(Number(round.round_id)) || null,
        areas: areasThisRound.map((row) => ({
          name: row.name,
          previous: row.previous_controller,
          controller: row.controller,
          loyalist_points: row.loyalist_points,
          traitor_points: row.traitor_points,
          reason: row.reason
        })),
        battles,
        notes
      };
    });
  return {
    complete,
    leader,
    factions: {
      Loyalist: { areas: counts.Loyalist, campaign_points: totals.Loyalist },
      Traitor: { areas: counts.Traitor, campaign_points: totals.Traitor }
    },
    loyalists: ranked(players, rows, "Loyalist"),
    traitors: ranked(players, rows, "Traitor"),
    control: history.map((row) => ({
      round_id: row.round_id,
      area_id: row.area_id,
      loyalist_points: row.loyalist_points,
      traitor_points: row.traitor_points,
      previous_controller: row.previous_controller,
      controller: row.controller
    })),
    log
  };
}

module.exports = {
  SCORING,
  publishedPairings,
  confirmedResults,
  scorePlayers,
  scoreState
};
