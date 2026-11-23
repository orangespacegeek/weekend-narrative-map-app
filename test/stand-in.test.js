"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generateSwiss } = require("../lib/swiss");
const { scoreState } = require("../lib/scoring");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function player(id, faction) {
  return { player_id: id, display_name: faction[0] + "-" + id, faction, dropped: false, army: "Line " + id, is_stand_in: false };
}

function standIn(id, faction, name) {
  return { player_id: id, display_name: name || "Bench", faction, dropped: false, army: null, bye: false, is_stand_in: true };
}

test("the roster can mark a TO stand-in and the public card shows the badge", () => {
  const html = fs.readFileSync(path.join(ROOT, "roster.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT, "js", "roster.js"), "utf8");
  assert.match(html, /name="stand_in"/);
  assert.match(html, /TO stand-in/);
  assert.match(script, /is_stand_in: form\.stand_in\.checked/);
  assert.match(script, /TO Stand-in/);
});

test("an existing stand-in is used first, and a rematch creates another slot", () => {
  const bench = standIn(9, "Traitor");
  const field = [player(1, "Loyalist"), player(2, "Loyalist"), player(4, "Traitor"), bench];
  const first = generateSwiss({ players: field, pairings: [], results: [], roundId: 1 });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.createdPlayers.length, 0);
  assert.equal(first.byes.length, 0);
  const standInGame = first.pairs.find((pair) => pair[1].player_id === 9);
  assert.equal(standInGame[0].player_id, 2);
  assert.deepEqual(first.pairs.find((pair) => pair[0].player_id === 1).map((side) => side.player_id), [1, 4]);

  const again = generateSwiss({
    players: [player(2, "Loyalist"), bench],
    pairings: [{ pairing_id: 1, round_id: 1, kind: "normal", loyalist_id: 2, traitor_id: 9 }],
    results: [],
    roundId: 2
  });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.createdPlayers.length, 1);
  assert.equal(again.createdPlayers[0].display_name, "TO Stand-in");
  assert.equal(again.createdPlayers[0].faction, "Traitor");
  assert.equal(again.pairs[0][0].player_id, 2);
  assert.equal(again.pairs[0][1].player_id, again.createdPlayers[0].player_id);
  assert.notEqual(again.pairs[0][1].player_id, 9);
});

test("the stand-in game goes to the lowest player who has not played one yet", () => {
  const bench = standIn(9, "Traitor");
  const players = [player(1, "Loyalist"), player(2, "Loyalist"), player(3, "Loyalist"), player(4, "Traitor"), bench];
  const prior = [{ pairing_id: 1, round_id: 1, kind: "normal", loyalist_id: 3, traitor_id: 9 }];
  const paired = generateSwiss({ players, pairings: prior, results: [], roundId: 2 });
  assert.equal(paired.ok, true, paired.error);
  const recipients = paired.pairs.filter((pair) => pair[1].is_stand_in).map((pair) => pair[0].player_id).sort();
  assert.deepEqual(recipients, [1, 2]);
  assert.equal(paired.pairs.find((pair) => pair[0].player_id === 2)[1].player_id, 9);
  assert.equal(paired.createdPlayers.length, 1);
  assert.equal(paired.pairs.find((pair) => pair[0].player_id === 3)[1].player_id, 4);

  const both = generateSwiss({
    players: [player(1, "Loyalist"), player(2, "Loyalist"), bench],
    pairings: [
      { pairing_id: 1, round_id: 1, kind: "normal", loyalist_id: 1, traitor_id: 9 },
      { pairing_id: 2, round_id: 2, kind: "normal", loyalist_id: 2, traitor_id: 9 }
    ],
    results: [],
    roundId: 3
  });
  assert.equal(both.ok, true, both.error);
  assert.match(both.warnings.join(" "), /already played a TO stand-in/);
  assert.equal(both.pairs[0][0].player_id, 2);
});

test("a stand-in game counts for the player, the faction, and the area, and is left out of Best General", () => {
  const players = [
    player(1, "Loyalist"),
    player(2, "Loyalist"),
    standIn(9, "Traitor", "TO Stand-in")
  ];
  const pairings = [{
    pairing_id: 1,
    round_id: 1,
    kind: "normal",
    state: "published",
    loyalist_id: 2,
    traitor_id: 9,
    area_id: 1,
    table: "1"
  }];
  const results = [{
    pairing_id: 1,
    round_id: 1,
    confirmation: "confirmed",
    outcome: "traitor_win",
    loyalist_vp: 4,
    traitor_vp: 14
  }];
  const scored = scoreState({
    players,
    pairings,
    results,
    rounds: [{ round_id: 1, number: 1 }],
    areas: [{ area_id: 1, name: "Gate" }],
    roundsPlanned: 1
  });
  const row = scored.loyalists.find((item) => item.display_name === "L-2");
  assert.equal(row.campaign_points, 0);
  assert.equal(row.vp_diff, -10);
  assert.equal(row.strength_of_schedule, 3);
  assert.equal(scored.loyalists.some((item) => item.display_name === "TO Stand-in"), false);
  assert.equal(scored.traitors.length, 0);
  assert.equal(scored.factions.Traitor.campaign_points, 3);
  assert.equal(scored.factions.Loyalist.campaign_points, 0);
  assert.equal(scored.control[0].traitor_points, 3);
  assert.equal(scored.control[0].controller, "Traitor");
});

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-standin-"));
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

async function admin(base) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password: ADMIN_PW })
  });
  const json = await res.json();
  return { Authorization: "Bearer " + json.token, "Content-Type": "application/json" };
}

test("a generated stand-in match gets a table and stays out of Best General", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers })).json();
    const areas = await (await fetch(ctx.base + "/api/areas")).json();
    const area = areas.slice().sort((a, b) => Number(a.area_id) - Number(b.area_id))[0];
    const savedArea = await fetch(ctx.base + "/api/areas/" + area.area_id, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...area, tables: ["1", "2"], scenario: "Breach" })
    });
    assert.equal(savedArea.status, 200, await savedArea.text());
    await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "L-01,Loyalist,Iron Hands\nL-02,Loyalist,Ultramarines\nT-01,Traitor,Night Lords" })
    });
    const createdBench = await fetch(ctx.base + "/api/players", {
      method: "POST",
      headers,
      body: JSON.stringify({ display_name: "Bench", faction: "Traitor", is_stand_in: true })
    });
    const bench = await createdBench.json();
    assert.equal(createdBench.status, 201, JSON.stringify(bench));
    assert.equal(bench.is_stand_in, true);
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    const generated = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/pair", {
      method: "POST",
      headers,
      body: "{}"
    });
    const body = await generated.json();
    assert.equal(generated.status, 200, JSON.stringify(body));
    const roster = await (await fetch(ctx.base + "/api/players", { headers })).json();
    assert.equal(roster.some((row) => row.display_name === "TO Stand-in"), false);
    const standInPairing = body.pairings.find((pairing) => Number(pairing.traitor_id) === Number(bench.player_id));
    assert.ok(standInPairing);
    assert.equal(standInPairing.kind, "normal");
    assert.ok(standInPairing.table);
    assert.equal(standInPairing.area_id, area.area_id);
    const loyal = roster.find((row) => Number(row.player_id) === Number(standInPairing.loyalist_id));
    assert.equal(loyal.display_name, "L-02");
    const pub = await (await fetch(ctx.base + "/api/public/entrants")).json();
    const badge = pub.find((row) => row.display_name === "Bench");
    assert.equal(badge.is_stand_in, true);
    assert.equal(badge.bye, undefined);
    assert.equal(JSON.stringify(pub).includes(event.event_code), false);

    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers, body: "{}" });
    const published = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    assert.equal(published.status, 200, await published.text());
    const reported = await fetch(ctx.base + "/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_code: event.event_code,
        round: 1,
        pairing_id: standInPairing.pairing_id,
        seat: "loyalist",
        loyalist_vp: 4,
        traitor_vp: 14
      })
    });
    const reportText = await reported.text();
    assert.equal(reported.status, 201, reportText);
    assert.equal(reportText.includes(event.event_code), false);
    const pending = await (await fetch(ctx.base + "/api/results", { headers })).json();
    const result = pending.find((row) => Number(row.pairing_id) === Number(standInPairing.pairing_id));
    const confirmed = await fetch(ctx.base + "/api/results/" + result.result_id + "/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({ as: "admin" })
    });
    assert.equal(confirmed.status, 200, await confirmed.text());
    const standings = await (await fetch(ctx.base + "/api/standings")).json();
    assert.equal(JSON.stringify(standings).includes(event.event_code), false);
    assert.equal(standings.traitors.some((row) => row.display_name === "T-01"), true);
    assert.equal(standings.traitors.some((row) => row.display_name === "Bench"), false);
    const played = standings.loyalists.find((row) => row.display_name === "L-02");
    assert.equal(played.vp_diff, -10);
    assert.equal(played.strength_of_schedule, 3);
    assert.equal(standings.factions.Traitor.campaign_points, 3);
    const control = await (await fetch(ctx.base + "/api/control")).json();
    const gate = control.find((row) => Number(row.area_id) === Number(area.area_id));
    assert.equal(gate.traitor_points, 3);
    assert.equal(gate.controller, "Traitor");
    assert.equal(JSON.stringify(control).includes(event.event_code), false);
  } finally {
    await ctx.stop();
  }
});
