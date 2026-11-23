/**
 * Tables come from the map. Each area contributes one seat per table number.
 * An area with a scenario and no table numbers contributes one seat, labeled
 * with the scenario (16 characters, the same limit as a table name).
 * Byes are never given a table. Assignment order is stable: area id, then the
 * table list, then pairing id.
 */
"use strict";

function clipTable(value) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, 16) : "";
}

function tableSlots(areas) {
  const slots = [];
  const seen = new Set();
  const warnings = [];
  const list = (areas || []).slice().sort((a, b) => Number(a.area_id) - Number(b.area_id));
  list.forEach((area) => {
    const named = (Array.isArray(area.tables) ? area.tables : [])
      .map(clipTable)
      .filter(Boolean);
    if (!named.length && area.scenario) {
      const label = clipTable(area.scenario);
      if (label) named.push(label);
    }
    named.forEach((table) => {
      if (seen.has(table)) {
        warnings.push("Table " + table + " is listed on more than one area. The first area keeps it.");
        return;
      }
      seen.add(table);
      slots.push({
        table,
        area_id: area.area_id,
        area: area.name,
        scenario: area.scenario || null
      });
    });
  });
  return { slots, warnings };
}

function tableConflicts(pairings, roundId) {
  const counts = new Map();
  (pairings || []).forEach((pairing) => {
    if (roundId != null && Number(pairing.round_id) !== Number(roundId)) return;
    if (!pairing.table || pairing.kind === "bye") return;
    const key = String(pairing.table);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const warnings = [];
  counts.forEach((count, table) => {
    if (count > 1) warnings.push("Table " + table + " is assigned to more than one game.");
  });
  return warnings;
}

function unique(list) {
  const out = [];
  list.forEach((item) => {
    if (item && !out.includes(item)) out.push(item);
  });
  return out;
}

function assignTables(pairings, areas) {
  const { slots, warnings } = tableSlots(areas);
  const byTable = new Map(slots.map((slot) => [slot.table, slot]));
  const next = (pairings || []).map((pairing) => ({ ...pairing }));
  const used = new Set();
  next.forEach((pairing) => {
    if (pairing.kind === "bye") {
      pairing.table = null;
      pairing.area_id = null;
      return;
    }
    if (!pairing.table) return;
    const slot = byTable.get(pairing.table);
    if (!slot) {
      warnings.push("Table " + pairing.table + " is not on the map.");
      return;
    }
    pairing.area_id = slot.area_id;
    used.add(pairing.table);
  });
  const free = slots.filter((slot) => !used.has(slot.table));
  let index = 0;
  next
    .slice()
    .sort((a, b) => Number(a.pairing_id) - Number(b.pairing_id))
    .forEach((pairing) => {
      if (pairing.kind === "bye" || pairing.table) return;
      const slot = free[index++];
      if (!slot) return;
      pairing.table = slot.table;
      pairing.area_id = slot.area_id;
      used.add(slot.table);
    });
  const open = next.filter((pairing) => pairing.kind !== "bye" && !pairing.table).length;
  if (open) {
    warnings.push(open + (open === 1 ? " game has" : " games have") + " no table. Add tables on the map.");
  }
  return { pairings: next, warnings: unique(warnings.concat(tableConflicts(next))) };
}

function person(players, id) {
  const player = (players || []).find((row) => Number(row.player_id) === Number(id));
  if (!player) return null;
  return {
    display_name: player.display_name,
    faction: player.faction,
    army: player.army || null
  };
}

function placeFor(pairing, slots, areas) {
  const slot = pairing.table ? slots.find((item) => item.table === pairing.table) : null;
  const area = (areas || []).find((item) => Number(item.area_id) === Number(pairing.area_id));
  return {
    table: pairing.table || null,
    area: (slot && slot.area) || (area && area.name) || null,
    scenario: (slot && slot.scenario) || (area && area.scenario) || null
  };
}

function buildSheet(input) {
  const round = input.round;
  const areas = input.areas || [];
  const players = input.players || [];
  const slots = tableSlots(areas).slots;
  const rows = (input.pairings || []).filter((pairing) => Number(pairing.round_id) === Number(round.round_id));
  const byTable = rows
    .filter((pairing) => pairing.kind !== "bye")
    .map((pairing) => ({
      ...placeFor(pairing, slots, areas),
      kind: pairing.kind,
      loyalist: person(players, pairing.loyalist_id),
      traitor: person(players, pairing.traitor_id)
    }))
    .sort((a, b) => String(a.table || "\uffff").localeCompare(String(b.table || "\uffff"), undefined, { numeric: true }));
  const byes = rows
    .filter((pairing) => pairing.kind === "bye")
    .map((pairing) => person(players, pairing.loyalist_id || pairing.traitor_id))
    .filter(Boolean);
  const byPlayer = [];
  rows.forEach((pairing) => {
    if (pairing.kind === "bye") {
      const who = person(players, pairing.loyalist_id || pairing.traitor_id);
      if (who) byPlayer.push({ ...who, table: null, area: null, scenario: null, opponent: null, bye: true });
      return;
    }
    const loc = placeFor(pairing, slots, areas);
    const loyalist = person(players, pairing.loyalist_id);
    const traitor = person(players, pairing.traitor_id);
    if (loyalist) byPlayer.push({ ...loyalist, ...loc, opponent: traitor, bye: false });
    if (traitor) byPlayer.push({ ...traitor, ...loc, opponent: loyalist, bye: false });
  });
  byPlayer.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  return {
    event_name: input.eventName || "Weekend Event",
    round: { round_id: round.round_id, number: round.number },
    by_table: byTable,
    by_player: byPlayer,
    byes,
    warnings: tableConflicts(rows, round.round_id)
  };
}

module.exports = { tableSlots, tableConflicts, assignTables, buildSheet };
