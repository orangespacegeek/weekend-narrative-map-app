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

test("Swiss keeps locked matches, avoids rematches, and pairs an uneven side with a TO stand-in", () => {
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

  const uneven = [player(1, "Loyalist"), player(2, "Loyalist"), player(4, "Traitor")];
  const withStandIn = generateSwiss({ players: uneven, pairings: [], results: [], roundId: 1 });
  assert.equal(withStandIn.ok, true, withStandIn.error);
  assert.equal(withStandIn.byes.length, 0);
  assert.equal(withStandIn.createdPlayers.length, 1);
  assert.equal(withStandIn.createdPlayers[0].is_stand_in, true);
  assert.equal(withStandIn.createdPlayers[0].faction, "Traitor");
  assert.equal(withStandIn.createdPlayers[0].display_name, "TO Stand-in");
  const standInId = withStandIn.createdPlayers[0].player_id;
  const unevenGames = withStandIn.pairs.map((pair) => pair[0].player_id + "-" + pair[1].player_id).sort();
  assert.deepEqual(unevenGames, ["1-4", "2-" + standInId].sort());

  const repeat = generateSwiss({ players: uneven, pairings: [], results: [], roundId: 1, seed: 3 });
  const repeatAgain = generateSwiss({ players: uneven, pairings: [], results: [], roundId: 1, seed: 3 });
  assert.equal(repeat.createdPlayers[0].player_id, repeatAgain.createdPlayers[0].player_id);
  assert.equal(
    repeat.pairs.find((pair) => pair[0].player_id === 2)[1].player_id,
    repeatAgain.pairs.find((pair) => pair[0].player_id === 2)[1].player_id
  );

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

function seats(pairings, players) {
  const name = (id) => {
    const player = players.find((row) => Number(row.player_id) === Number(id));
    return player ? player.display_name : "";
  };
  return pairings
    .map((pairing) => {
      if (pairing.kind === "bye") return "bye:" + name(pairing.loyalist_id || pairing.traitor_id);
      return pairing.kind + ":" + name(pairing.loyalist_id) + ":" + name(pairing.traitor_id);
    })
    .sort();
}

test("visitors see no bye result until the round is published", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const imported = await (await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "L-01,Loyalist,Iron Hands\nL-02,Loyalist,Ultramarines\nT-01,Traitor,Night Lords" })
    })).json();
    const players = imported.added;
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    const loyalist = players.find((player) => player.display_name === "L-02");
    const other = players.find((player) => player.display_name === "L-01");
    const traitor = players.find((player) => player.display_name === "T-01");
    const byeResponse = await fetch(ctx.base + "/api/pairings", {
      method: "POST",
      headers,
      body: JSON.stringify({ round_id: round.round_id, kind: "bye", loyalist_id: loyalist.player_id, traitor_id: null })
    });
    const bye = await byeResponse.json();
    assert.equal(byeResponse.status, 201, JSON.stringify(bye));
    assert.equal(bye.kind, "bye");
    const gameResponse = await fetch(ctx.base + "/api/pairings", {
      method: "POST",
      headers,
      body: JSON.stringify({
        round_id: round.round_id,
        kind: "normal",
        loyalist_id: other.player_id,
        traitor_id: traitor.player_id
      })
    });
    const game = await gameResponse.json();
    assert.equal(gameResponse.status, 201, JSON.stringify(game));
    const scored = await fetch(ctx.base + "/api/results", {
      method: "POST",
      headers,
      body: JSON.stringify({
        pairing_id: game.pairing_id,
        round_id: round.round_id,
        loyalist_vp: 12,
        traitor_vp: 8,
        reported_by: "admin",
        confirmation: "confirmed",
        confirmed_by: "admin"
      })
    });
    assert.equal(scored.status, 201);
    const publicPairings = await (await fetch(ctx.base + "/api/pairings")).json();
    const publicResults = await (await fetch(ctx.base + "/api/results")).json();
    const adminResults = await (await fetch(ctx.base + "/api/results", { headers })).json();
    assert.equal(publicPairings.some((pairing) => pairing.kind === "bye"), false);
    assert.deepEqual(publicResults, []);
    assert.equal(adminResults.some((result) => result.outcome === "bye"), false);
    assert.equal(adminResults.length, 1);
    const hidden = await fetch(ctx.base + "/api/results/" + adminResults[0].result_id);
    assert.equal(hidden.status, 404);
    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers, body: "{}" });
    const published = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    assert.equal(published.status, 200);
    const visiblePairings = await (await fetch(ctx.base + "/api/pairings")).json();
    const visibleResults = await (await fetch(ctx.base + "/api/results")).json();
    assert.equal(visiblePairings.some((pairing) => pairing.kind === "bye"), true);
    const byeResult = visibleResults.find((result) => result.outcome === "bye");
    assert.ok(byeResult);
    const byePlayer = players.find((player) => Number(player.player_id) === Number(bye.loyalist_id || bye.traitor_id));
    const vp = byePlayer.faction === "Loyalist" ? byeResult.loyalist_vp : byeResult.traitor_vp;
    assert.equal(vp, 10);
    assert.equal(visibleResults.length, 2);
    const open = await fetch(ctx.base + "/api/results/" + byeResult.result_id);
    assert.equal(open.status, 200);
  } finally {
    await ctx.stop();
  }
});

test("regenerating a draft matches a fresh pairing", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const imported = await (await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "L-01,Loyalist\nL-02,Loyalist\nL-03,Loyalist\nT-01,Traitor\nT-02,Traitor\nT-03,Traitor"
      })
    })).json();
    const id = (display) => imported.added.find((player) => player.display_name === display).player_id;
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    await fetch(ctx.base + "/api/pairings", {
      method: "POST",
      headers,
      body: JSON.stringify({
        round_id: round.round_id,
        kind: "grudge",
        state: "draft",
        loyalist_id: id("L-01"),
        traitor_id: id("T-01")
      })
    });
    const pair = () => fetch(ctx.base + "/api/rounds/" + round.round_id + "/pair", {
      method: "POST",
      headers,
      body: "{}"
    });
    assert.equal((await pair()).status, 200);
    const fresh = await (await fetch(ctx.base + "/api/pairings", { headers })).json();
    assert.equal((await pair()).status, 200);
    const again = await (await fetch(ctx.base + "/api/pairings", { headers })).json();
    const expected = ["grudge:L-01:T-01", "normal:L-02:T-02", "normal:L-03:T-03"];
    assert.deepEqual(seats(fresh, imported.added), expected);
    assert.deepEqual(seats(again, imported.added), expected);
    assert.equal(again.filter((pairing) => pairing.kind === "grudge").length, 1);
  } finally {
    await ctx.stop();
  }

  const byeCtx = startServer();
  try {
    await byeCtx.ready;
    const headers = await admin(byeCtx.base);
    const imported = await (await fetch(byeCtx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "L-01,Loyalist\nL-02,Loyalist\nT-01,Traitor" })
    })).json();
    const round = await (await fetch(byeCtx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    const pair = () => fetch(byeCtx.base + "/api/rounds/" + round.round_id + "/pair", {
      method: "POST",
      headers,
      body: "{}"
    });
    const fresh = await (await pair()).json();
    const roster = await (await fetch(byeCtx.base + "/api/players", { headers })).json();
    const again = await (await pair()).json();
    const rosterAgain = await (await fetch(byeCtx.base + "/api/players", { headers })).json();
    const expected = ["normal:L-01:T-01", "normal:L-02:TO Stand-in"];
    assert.deepEqual(seats(fresh.pairings, roster), expected);
    assert.deepEqual(seats(again.pairings, rosterAgain), expected);
    assert.equal(rosterAgain.filter((player) => player.is_stand_in).length, 1);
    const stored = await (await fetch(byeCtx.base + "/api/pairings", { headers })).json();
    assert.equal(stored.filter((pairing) => pairing.kind === "bye").length, 0);
    const results = await (await fetch(byeCtx.base + "/api/results", { headers })).json();
    assert.deepEqual(results, []);
  } finally {
    await byeCtx.stop();
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
