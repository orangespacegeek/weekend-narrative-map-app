"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const model = require("../lib/model");

test("an imported system becomes an area and can be shown as a system again", () => {
  const area = model.areaFromSystem({
    sys_id: 4,
    sys_name: "West Gate",
    sys_links: "1,5",
    sys_notes: "",
    sys_x: 230,
    sys_y: 200
  });
  assert.equal(area.area_id, 4);
  assert.equal(area.name, "West Gate");
  assert.deepEqual(area.routes, [1, 5]);
  assert.equal(area.shape, "point");
  assert.equal(Object.prototype.hasOwnProperty.call(area, "sys_id"), false);
  const sys = model.systemFromArea(area);
  assert.equal(sys.sys_id, 4);
  assert.equal(sys.sys_links, "1,5");
});

test("campaign points, bye minimum, and area control follow the event rules", () => {
  assert.deepEqual(model.campaignPoints({ outcome: "loyalist_win" }), { loyalist: 3, traitor: 0 });
  assert.deepEqual(model.campaignPoints({ outcome: "tie" }), { loyalist: 1, traitor: 1 });
  assert.deepEqual(model.campaignPoints({ outcome: "bye", loyalist_vp: 10, traitor_vp: null }), { loyalist: 3, traitor: 0 });

  assert.equal(model.nextController("neutral", 0, 0), "neutral");
  assert.equal(model.nextController("Loyalist", 3, 3), "Loyalist");
  assert.equal(model.nextController("neutral", 0, 3), "Traitor");
  assert.equal(model.factionLeader(["Loyalist", "Loyalist", "neutral", "Traitor"]), "Loyalist");
  assert.equal(model.factionLeader(["Loyalist", "Traitor"]), null);
});

test("standings sort by campaign points, then VP difference, then strength of schedule", () => {
  const rows = [
    { id: "low", campaign_points: 3, vp_diff: 20, strength_of_schedule: 9 },
    { id: "sos", campaign_points: 6, vp_diff: 4, strength_of_schedule: 12 },
    { id: "vp", campaign_points: 6, vp_diff: 8, strength_of_schedule: 1 },
    { id: "top", campaign_points: 9, vp_diff: 1, strength_of_schedule: 0 }
  ];
  rows.sort(model.compareStandings);
  assert.deepEqual(rows.map((row) => row.id), ["top", "vp", "sos", "low"]);
});

test("a tied area keeps the previous holder instead of handing it to Traitor", () => {
  const first = model.validateControl(
    { round_id: 1, area_id: 1, loyalist_points: 3, traitor_points: 0, previous_controller: "neutral" },
    { rounds: [{ round_id: 1 }], areas: [{ area_id: 1 }], control: [] }
  );
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.controller, "Loyalist");
  assert.equal(first.value.loyalist_total, 3);

  const second = model.validateControl(
    {
      round_id: 2,
      area_id: 1,
      loyalist_points: 0,
      traitor_points: 3,
      previous_controller: "Loyalist",
      controller: "Traitor"
    },
    { rounds: [{ round_id: 2 }], areas: [{ area_id: 1 }], control: [first.value] }
  );
  assert.equal(second.ok, false);
  const kept = model.validateControl(
    { round_id: 2, area_id: 1, loyalist_points: 0, traitor_points: 3, previous_controller: "Loyalist" },
    { rounds: [{ round_id: 2 }], areas: [{ area_id: 1 }], control: [first.value] }
  );
  assert.equal(kept.ok, true, kept.error);
  assert.equal(kept.value.loyalist_total, 3);
  assert.equal(kept.value.traitor_total, 3);
  assert.equal(kept.value.controller, "Loyalist");
});

test("players cannot carry contact fields, and apex matches stay locked", () => {
  const player = model.validatePlayer({ display_name: "L-01", faction: "Loyalist", email: "a@b.c" }, null);
  assert.equal(player.ok, false);

  const apex = model.validatePairing(
    { kind: "apex", locked: false, round_id: 1, loyalist_id: 1, traitor_id: 2, state: "draft" },
    null,
    {
      rounds: [{ round_id: 1 }],
      players: [
        { player_id: 1, faction: "Loyalist", dropped: false },
        { player_id: 2, faction: "Traitor", dropped: false }
      ],
      pairings: []
    }
  );
  assert.equal(apex.ok, false);

  const rematch = model.findRematch(
    [{ pairing_id: 1, kind: "normal", loyalist_id: 1, traitor_id: 2 }],
    2,
    1,
    null
  );
  assert.equal(rematch.pairing_id, 1);
  assert.equal(model.normalizeAdminRole("campaign_admin"), "event_admin");

  const bye = model.validateResult(
    { pairing_id: 3, round_id: 1, loyalist_vp: 9, traitor_vp: null, outcome: "bye" },
    null,
    { pairings: [{ pairing_id: 3, round_id: 1, kind: "bye", loyalist_id: 1, traitor_id: null }] }
  );
  assert.equal(bye.ok, false);
  const awarded = model.validateResult(
    { pairing_id: 3, round_id: 1, loyalist_vp: 10, traitor_vp: null },
    null,
    { pairings: [{ pairing_id: 3, round_id: 1, kind: "bye", loyalist_id: 1, traitor_id: null }] }
  );
  assert.equal(awarded.ok, true, awarded.error);
  assert.equal(awarded.value.outcome, "bye");
  assert.deepEqual(awarded.value.campaign_points, { loyalist: 3, traitor: 0 });
});
