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
  assert.equal(model.factionLeader(["Loyalist", "Loyalist", "neutral", "Traitor"], { loyalist: 1, traitor: 20 }), "Loyalist");
  assert.equal(model.factionLeader(["Loyalist", "Traitor"], { loyalist: 9, traitor: 4 }), "Loyalist");
  assert.equal(model.factionLeader(["Loyalist", "Traitor"], { loyalist: 4, traitor: 9 }), "Traitor");
  assert.equal(model.factionLeader(["Loyalist", "Traitor"], { loyalist: 6, traitor: 6 }), null);
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

test("area control is decided from this round's points, and a tie keeps the previous holder", () => {
  const ctx = { rounds: [{ round_id: 1 }, { round_id: 2 }], areas: [{ area_id: 1 }] };
  const first = model.validateControl(
    { round_id: 1, area_id: 1, loyalist_points: 3, traitor_points: 0, previous_controller: "neutral" },
    { ...ctx, control: [] }
  );
  assert.equal(first.ok, true, first.error);
  assert.equal(first.value.controller, "Loyalist");
  assert.equal(first.value.loyalist_total, undefined);

  const taken = model.validateControl(
    { round_id: 2, area_id: 1, loyalist_points: 0, traitor_points: 3, previous_controller: "Loyalist" },
    { ...ctx, control: [first.value] }
  );
  assert.equal(taken.ok, true, taken.error);
  assert.equal(taken.value.controller, "Traitor");
  assert.equal(taken.value.previous_controller, "Loyalist");

  const tied = model.validateControl(
    { round_id: 2, area_id: 1, loyalist_points: 3, traitor_points: 3, previous_controller: "Loyalist" },
    { ...ctx, control: [first.value] }
  );
  assert.equal(tied.ok, true, tied.error);
  assert.equal(tied.value.controller, "Loyalist");

  const untouched = model.validateControl(
    { round_id: 1, area_id: 1, loyalist_points: 0, traitor_points: 0, previous_controller: "neutral" },
    { ...ctx, control: [] }
  );
  assert.equal(untouched.value.controller, "neutral");

  const claimed = model.validateControl(
    { round_id: 2, area_id: 1, loyalist_points: 1, traitor_points: 1, previous_controller: "Loyalist", controller: "Traitor" },
    { ...ctx, control: [first.value] }
  );
  assert.equal(claimed.ok, false);
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

  const played = [{ pairing_id: 1, kind: "normal", loyalist_id: 1, traitor_id: 2 }];
  const seat = {
    rounds: [{ round_id: 2 }],
    players: [
      { player_id: 1, faction: "Loyalist", dropped: false },
      { player_id: 2, faction: "Traitor", dropped: false }
    ],
    pairings: played
  };
  for (const kind of ["apex", "grudge"]) {
    const again = model.validatePairing(
      { kind, round_id: 2, state: "draft", loyalist_id: 1, traitor_id: 2 },
      null,
      seat
    );
    assert.equal(again.ok, false, kind);
    assert.match(again.error, /already been paired/);
  }
  const army = model.validatePlayer({ display_name: "L-01", faction: "Loyalist", army: "Sons of Horus" }, null);
  assert.equal(army.ok, true, army.error);
  assert.equal(army.value.army, "Sons of Horus");
  assert.equal(model.publicEntrant(army.value).army, "Sons of Horus");
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
