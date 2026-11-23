"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { scoreState } = require("../lib/scoring");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function player(id, faction, name) {
  return { player_id: id, display_name: name, faction, army: faction + " army", dropped: false };
}

test("campaign points, byes, and Best General tiebreaks follow the event rules", () => {
  const players = [
    player(1, "Loyalist", "L-01"),
    player(2, "Loyalist", "L-02"),
    player(3, "Traitor", "T-01"),
    player(4, "Traitor", "T-02")
  ];
  const pairings = [
    { pairing_id: 1, round_id: 1, state: "published", kind: "normal", area_id: 1, loyalist_id: 1, traitor_id: 3 },
    { pairing_id: 2, round_id: 1, state: "published", kind: "normal", area_id: 2, loyalist_id: 2, traitor_id: 4 },
    { pairing_id: 3, round_id: 1, state: "published", kind: "bye", loyalist_id: null, traitor_id: 3 }
  ];
  const results = [
    { pairing_id: 1, round_id: 1, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 10, traitor_vp: 0 },
    { pairing_id: 2, round_id: 1, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 10, traitor_vp: 0 },
    { pairing_id: 3, round_id: 1, confirmation: "confirmed", outcome: "bye", loyalist_vp: null, traitor_vp: 10 }
  ];
  const scored = scoreState({
    players,
    pairings,
    results,
    rounds: [{ round_id: 1, number: 1 }],
    areas: [{ area_id: 1, name: "Wall" }, { area_id: 2, name: "Gate" }],
    roundsPlanned: 4
  });
  const bye = scored.traitors.find((row) => row.display_name === "T-01");
  assert.equal(bye.campaign_points, 3);
  assert.equal(bye.vp_diff, 0);
  assert.equal(bye.wins, 1);
  assert.equal(bye.losses, 1);
  const first = scored.loyalists[0];
  const second = scored.loyalists[1];
  assert.equal(first.display_name, "L-01");
  assert.equal(second.display_name, "L-02");
  assert.equal(first.campaign_points, second.campaign_points);
  assert.equal(first.vp_diff, second.vp_diff);
  assert.equal(first.strength_of_schedule, 3);
  assert.equal(second.strength_of_schedule, 0);
});

test("area control flips, a tie keeps the holder, and the faction winner uses areas then campaign points", () => {
  const players = [player(1, "Loyalist", "L-01"), player(2, "Traitor", "T-01"), player(3, "Loyalist", "L-02"), player(4, "Traitor", "T-02")];
  const areas = [{ area_id: 1, name: "Wall" }, { area_id: 2, name: "Gate" }];
  const rounds = [{ round_id: 1, number: 1 }, { round_id: 2, number: 2 }];
  const basePairs = [
    { pairing_id: 1, round_id: 1, state: "published", kind: "apex", area_id: 1, loyalist_id: 1, traitor_id: 2 },
    { pairing_id: 2, round_id: 1, state: "published", kind: "normal", area_id: 2, loyalist_id: 3, traitor_id: 4 }
  ];
  const baseResults = [
    { pairing_id: 1, round_id: 1, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 8, traitor_vp: 2, note: "Held the wall" },
    { pairing_id: 2, round_id: 1, confirmation: "confirmed", outcome: "traitor_win", loyalist_vp: 1, traitor_vp: 9 }
  ];
  const tied = scoreState({
    players,
    areas,
    rounds,
    roundsPlanned: 2,
    pairings: basePairs.concat([
      { pairing_id: 3, round_id: 2, state: "published", kind: "normal", area_id: 1, loyalist_id: 3, traitor_id: 2 }
    ]),
    results: baseResults.concat([
      { pairing_id: 3, round_id: 2, confirmation: "confirmed", outcome: "tie", loyalist_vp: 5, traitor_vp: 5 }
    ])
  });
  const wall = tied.control.filter((row) => row.area_id === 1);
  assert.equal(wall[0].controller, "Loyalist");
  assert.equal(wall[1].controller, "Loyalist");
  assert.equal(wall[1].previous_controller, "Loyalist");
  assert.equal(tied.factions.Loyalist.areas, 1);
  assert.equal(tied.factions.Traitor.areas, 1);
  assert.equal(tied.leader, null);
  assert.equal(tied.log[0].battles[0].kind, "apex");
  assert.equal(tied.log[0].notes[0].note, "Held the wall");

  const flipped = scoreState({
    players,
    areas,
    rounds,
    roundsPlanned: 2,
    pairings: basePairs.concat([
      { pairing_id: 3, round_id: 2, state: "published", kind: "grudge", area_id: 1, loyalist_id: 3, traitor_id: 2 }
    ]),
    results: baseResults.concat([
      { pairing_id: 3, round_id: 2, confirmation: "confirmed", outcome: "traitor_win", loyalist_vp: 2, traitor_vp: 11 }
    ])
  });
  assert.equal(flipped.control.filter((row) => row.area_id === 1)[1].controller, "Traitor");
  assert.equal(flipped.factions.Traitor.areas, 2);
  assert.equal(flipped.leader, "Traitor");

  const points = scoreState({
    players,
    areas,
    rounds: rounds.slice(0, 1),
    roundsPlanned: 4,
    pairings: basePairs.concat([
      { pairing_id: 9, round_id: 1, state: "published", kind: "bye", loyalist_id: 1, traitor_id: null }
    ]),
    results: baseResults.concat([
      { pairing_id: 9, round_id: 1, confirmation: "confirmed", outcome: "bye", loyalist_vp: 10, traitor_vp: null }
    ])
  });
  assert.equal(points.factions.Loyalist.areas, points.factions.Traitor.areas);
  assert.ok(points.factions.Loyalist.campaign_points > points.factions.Traitor.campaign_points);
  assert.equal(points.leader, "Loyalist");

  const ignored = scoreState({
    players,
    areas,
    rounds,
    roundsPlanned: 4,
    pairings: basePairs.concat([
      { pairing_id: 8, round_id: 2, state: "draft", kind: "normal", area_id: 1, loyalist_id: 3, traitor_id: 2 }
    ]),
    results: baseResults.concat([
      { pairing_id: 1, round_id: 1, confirmation: "pending", outcome: "traitor_win", loyalist_vp: 0, traitor_vp: 20 },
      { pairing_id: 8, round_id: 2, confirmation: "confirmed", outcome: "traitor_win", loyalist_vp: 0, traitor_vp: 20 }
    ])
  });
  assert.equal(ignored.control.filter((row) => row.area_id === 1).pop().controller, "Loyalist");
  assert.equal(ignored.log.length, 1);
});

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-score-"));
  const port = 41000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "development",
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start\n" + log)), 8000);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes("Health:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + "\n" + log));
    });
  });
  return {
    base: "http://127.0.0.1:" + port,
    ready,
    async stop() {
      await new Promise((resolve) => {
        child.removeAllListeners("exit");
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

async function login(base) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password: ADMIN_PW })
  });
  const json = await res.json();
  const cookie = (res.headers.get("set-cookie") || "").match(/sh_session=([^;]+)/);
  return {
    cookie: cookie && cookie[1],
    token: json.token,
    headers: { Authorization: "Bearer " + json.token, "Content-Type": "application/json", "X-SH-Request": "1" }
  };
}

test("public standings, control, and the log ignore anything that is not confirmed and published", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const headers = auth.headers;
    const loyal = await (await fetch(ctx.base + "/api/players", {
      method: "POST", headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "Iron Hands" })
    })).json();
    const traitor = await (await fetch(ctx.base + "/api/players", {
      method: "POST", headers,
      body: JSON.stringify({ display_name: "T-01", faction: "Traitor", army: "Night Lords" })
    })).json();
    const areas = await (await fetch(ctx.base + "/api/areas")).json();
    const areaId = areas[0].area_id;
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST", headers, body: JSON.stringify({ number: 1 })
    })).json();
    const hidden = await (await fetch(ctx.base + "/api/pairings", {
      method: "POST", headers,
      body: JSON.stringify({
        round_id: round.round_id, kind: "normal", state: "draft", area_id: areaId, table: "9",
        loyalist_id: loyal.player_id, traitor_id: traitor.player_id
      })
    })).json();
    await fetch(ctx.base + "/api/results", {
      method: "POST", headers,
      body: JSON.stringify({
        pairing_id: hidden.pairing_id, round_id: round.round_id,
        loyalist_vp: 1, traitor_vp: 15, reported_by: "admin", confirmation: "confirmed", confirmed_by: "admin"
      })
    });
    const before = await (await fetch(ctx.base + "/api/standings")).json();
    assert.equal(before.loyalists.find((row) => row.display_name === "L-01").campaign_points, 0);
    assert.equal((await (await fetch(ctx.base + "/api/narrative")).json()).rounds.length, 0);
    assert.equal((await (await fetch(ctx.base + "/api/public/map")).json()).areas.find((area) => Number(area.area_id) === Number(areaId)).controller, "neutral");

    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers, body: "{}" });
    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    const pending = await (await fetch(ctx.base + "/api/pairings", { headers })).json();
    const game = pending.find((row) => row.table === "9");
    await fetch(ctx.base + "/api/results/" + (await (await fetch(ctx.base + "/api/results", { headers })).json())[0].result_id, {
      method: "PUT", headers,
      body: JSON.stringify({
        pairing_id: game.pairing_id, round_id: round.round_id,
        loyalist_vp: 1, traitor_vp: 15, outcome: "traitor_win",
        confirmation: "pending", reported_by: "traitor", confirmed_by: null
      })
    });
    const pendingBoard = await (await fetch(ctx.base + "/api/standings")).json();
    assert.equal(pendingBoard.factions.Traitor.campaign_points, 0);
    assert.equal((await (await fetch(ctx.base + "/api/narrative")).json()).rounds[0].battles.length, 0);

    await fetch(ctx.base + "/api/results/" + (await (await fetch(ctx.base + "/api/results", { headers })).json())[0].result_id, {
      method: "PUT", headers,
      body: JSON.stringify({
        pairing_id: game.pairing_id, round_id: round.round_id,
        loyalist_vp: 1, traitor_vp: 15, outcome: "traitor_win",
        confirmation: "confirmed", reported_by: "admin", confirmed_by: "admin", note: "The gate fell"
      })
    });
    const live = await (await fetch(ctx.base + "/api/standings")).json();
    assert.equal(live.factions.Traitor.campaign_points, 3);
    assert.equal(live.leader, "Traitor");
    const map = await (await fetch(ctx.base + "/api/public/map")).json();
    assert.equal(map.areas.find((area) => Number(area.area_id) === Number(areaId)).controller, "Traitor");
    const log = await (await fetch(ctx.base + "/api/narrative")).json();
    assert.equal(log.rounds[0].notes[0].note, "The gate fell");
    assert.equal(JSON.stringify(live).includes("event_code"), false);
    assert.equal(JSON.stringify(log).includes("event_code"), false);

    const anon = await fetch(ctx.base + "/api/narrative", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ round_id: round.round_id, blurb: "A hard round" })
    });
    assert.equal(anon.status, 401);
    const noCsrf = await fetch(ctx.base + "/api/narrative", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token, Cookie: "sh_session=" + auth.cookie },
      body: JSON.stringify({ round_id: round.round_id, blurb: "A hard round" })
    });
    assert.equal(noCsrf.status, 403);
    const phone = await fetch(ctx.base + "/api/narrative", {
      method: "POST", headers,
      body: JSON.stringify({ round_id: round.round_id, blurb: "call 5551234567" })
    });
    assert.equal(phone.status, 400);
    const saved = await fetch(ctx.base + "/api/narrative", {
      method: "POST",
      headers: { ...headers, Cookie: "sh_session=" + auth.cookie },
      body: JSON.stringify({ round_id: round.round_id, blurb: "The wall changed hands." })
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const after = await (await fetch(ctx.base + "/api/narrative")).json();
    assert.equal(after.rounds[0].blurb, "The wall changed hands.");
    assert.equal(JSON.stringify(after).includes("5551234567"), false);
  } finally {
    await ctx.stop();
  }
});
