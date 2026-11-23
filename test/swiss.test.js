"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { generateSwiss, scoreEvent } = require("../lib/swiss");
const model = require("../lib/model");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function player(id, faction) {
  return { player_id: id, display_name: faction[0] + "-" + id, faction, dropped: false, army: "Line " + id };
}

test("standings order is campaign points, then VP difference, then strength of schedule", () => {
  const players = [player(1, "Loyalist"), player(2, "Loyalist"), player(3, "Traitor"), player(4, "Traitor")];
  const pairings = [
    { pairing_id: 1, round_id: 1, kind: "normal", loyalist_id: 1, traitor_id: 3 },
    { pairing_id: 2, round_id: 1, kind: "normal", loyalist_id: 2, traitor_id: 4 }
  ];
  const results = [
    { pairing_id: 1, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 12, traitor_vp: 4 },
    { pairing_id: 2, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 8, traitor_vp: 7 }
  ];
  const scores = scoreEvent(players, pairings, results);
  assert.equal(scores[1].campaign_points, 3);
  assert.equal(scores[1].vp_diff, 8);
  assert.equal(scores[2].vp_diff, 1);
  assert.ok(model.compareStandings(scores[1], scores[2]) < 0);
  assert.equal(scores[1].strength_of_schedule, scores[3].campaign_points);
  const harder = { campaign_points: 3, vp_diff: 8, strength_of_schedule: 1 };
  const softer = { campaign_points: 3, vp_diff: 8, strength_of_schedule: 4 };
  assert.ok(model.compareStandings(softer, harder) < 0);
});

test("Swiss keeps locked matches, avoids rematches, and gives the bye to the lowest eligible player", () => {
  const players = [1, 2, 3].map((id) => player(id, "Loyalist")).concat([4, 5, 6].map((id) => player(id, "Traitor")));
  players.push({ ...player(7, "Loyalist"), dropped: true });
  const prior = [{ pairing_id: 1, round_id: 1, kind: "normal", state: "published", loyalist_id: 1, traitor_id: 4 }];
  const results = [{ pairing_id: 1, confirmation: "confirmed", outcome: "loyalist_win", loyalist_vp: 10, traitor_vp: 2 }];
  const locked = [{ pairing_id: 9, round_id: 2, kind: "grudge", locked: true, state: "draft", loyalist_id: 2, traitor_id: 5 }];
  const paired = generateSwiss({ players, pairings: prior.concat(locked), results, roundId: 2 });
  assert.equal(paired.ok, true, paired.error);
  assert.equal(paired.byes.length, 0);
  const games = paired.pairs.map((pair) => pair[0].player_id + "-" + pair[1].player_id).sort();
  assert.deepEqual(games, ["1-6", "3-4"]);
  assert.equal(paired.pairs.some((pair) => pair[0].player_id === 2 || pair[1].player_id === 5), false);

  const byeField = [player(1, "Loyalist"), player(2, "Loyalist"), player(4, "Traitor")];
  const withBye = generateSwiss({ players: byeField, pairings: [], results: [], roundId: 1 });
  assert.equal(withBye.ok, true, withBye.error);
  assert.equal(withBye.byes.length, 1);
  assert.equal(withBye.byes[0].player_id, 2);
  assert.deepEqual([withBye.pairs[0][0].player_id, withBye.pairs[0][1].player_id], [1, 4]);

  const repeat = generateSwiss({ players: byeField, pairings: [], results: [], roundId: 1, seed: 3 });
  const repeatAgain = generateSwiss({ players: byeField, pairings: [], results: [], roundId: 1, seed: 3 });
  assert.equal(repeat.byes[0].player_id, repeatAgain.byes[0].player_id);

  const stuck = generateSwiss({
    players: [player(1, "Loyalist"), player(4, "Traitor")],
    pairings: prior,
    results,
    roundId: 3
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /rematch/);
});

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-swiss-"));
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

test("draft pairings stay private until the organiser publishes them", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "L-01,Loyalist,Iron Hands\nL-02,Loyalist\nT-01,Traitor\nT-02,Traitor" })
    });
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    const generated = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/pair", {
      method: "POST",
      headers,
      body: JSON.stringify({ seed: 1 })
    });
    const body = await generated.json();
    assert.equal(generated.status, 200, JSON.stringify(body));
    assert.equal(body.pairings.length, 2);
    assert.equal(body.pairings.every((pairing) => pairing.state === "draft"), true);
    const hidden = await (await fetch(ctx.base + "/api/pairings")).json();
    assert.deepEqual(hidden, []);
    const early = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    assert.equal(early.status, 409);
    const approved = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers, body: "{}" });
    assert.equal(approved.status, 200);
    const published = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    assert.equal(published.status, 200);
    const visible = await (await fetch(ctx.base + "/api/pairings")).json();
    assert.equal(visible.length, 2);
    assert.equal(visible.every((pairing) => pairing.state === "published"), true);
    assert.equal(JSON.stringify(visible).includes("@"), false);
  } finally {
    await ctx.stop();
  }
});

test("an army that looks like an email or a phone number is rejected", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const email = await fetch(ctx.base + "/api/players", {
      method: "POST",
      headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "pilot@example.com" })
    });
    assert.equal(email.status, 400);
    assert.match((await email.json()).error, /email address or a phone number/);
    const phone = await fetch(ctx.base + "/api/players", {
      method: "POST",
      headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "555-010-1234" })
    });
    assert.equal(phone.status, 400);
    const pasted = await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "L-01,Loyalist,5551234567" })
    });
    assert.equal(pasted.status, 400);
    const fine = await fetch(ctx.base + "/api/players", {
      method: "POST",
      headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "Iron Hands" })
    });
    assert.equal(fine.status, 201);
  } finally {
    await ctx.stop();
  }
});
