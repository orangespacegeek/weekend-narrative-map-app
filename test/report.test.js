"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-report-"));
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
    token: json.token,
    cookie: cookie && cookie[1],
    headers: { Authorization: "Bearer " + json.token, "Content-Type": "application/json", "X-SH-Request": "1" }
  };
}

async function setup(base, headers) {
  const imported = await (await fetch(base + "/api/players/import", {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "L-01,Loyalist,Iron Hands\nL-02,Loyalist,Ultramarines\nL-03,Loyalist\nT-01,Traitor,Night Lords\nT-02,Traitor,Word Bearers"
    })
  })).json();
  const id = (name) => imported.added.find((player) => player.display_name === name).player_id;
  const round = await (await fetch(base + "/api/rounds", {
    method: "POST",
    headers,
    body: JSON.stringify({ number: 1 })
  })).json();
  async function pairing(body) {
    const res = await fetch(base + "/api/pairings", { method: "POST", headers, body: JSON.stringify({ round_id: round.round_id, state: "draft", ...body }) });
    const json = await res.json();
    assert.equal(res.status, 201, JSON.stringify(json));
    return json;
  }
  const grudge = await pairing({ kind: "grudge", table: "1", loyalist_id: id("L-01"), traitor_id: id("T-01") });
  const normal = await pairing({ kind: "normal", table: "2", loyalist_id: id("L-02"), traitor_id: id("T-02") });
  const bye = await pairing({ kind: "bye", loyalist_id: id("L-03"), traitor_id: null });
  return { round, grudge, normal, bye };
}

async function publish(base, headers, roundId) {
  const approved = await fetch(base + "/api/rounds/" + roundId + "/approve", { method: "POST", headers, body: "{}" });
  assert.equal(approved.status, 200);
  const published = await fetch(base + "/api/rounds/" + roundId + "/publish", { method: "POST", headers, body: "{}" });
  assert.equal(published.status, 200);
}

function report(base, body) {
  return fetch(base + "/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("the event code gates a report, and a bad code is rate limited", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers: auth.headers })).json();
    const { round, normal } = await setup(ctx.base, auth.headers);
    const early = await report(ctx.base, {
      event_code: event.event_code,
      round: round.number,
      pairing_id: normal.pairing_id,
      seat: "loyalist",
      outcome: "loyalist_win",
      loyalist_vp: 10,
      traitor_vp: 4
    });
    const earlyText = await early.text();
    assert.equal(early.status, 404);
    assert.match(earlyText, /not published/);
    assert.equal(earlyText.includes(event.event_code), false);
    await publish(ctx.base, auth.headers, round.round_id);

    const missing = await report(ctx.base, { round: 1, pairing_id: normal.pairing_id, seat: "loyalist", loyalist_vp: 10, traitor_vp: 4, outcome: "loyalist_win" });
    const missingText = await missing.text();
    assert.equal(missing.status, 401);
    assert.equal(missingText.includes(event.event_code), false);

    const wrong = await report(ctx.base, { event_code: "BAD-CODE", round: 1, pairing_id: normal.pairing_id, seat: "loyalist", loyalist_vp: 10, traitor_vp: 4, outcome: "loyalist_win" });
    const wrongText = await wrong.text();
    assert.equal(wrong.status, 401);
    assert.equal(wrongText.includes(event.event_code), false);
    assert.equal(wrongText.includes("BAD-CODE"), false);

    const right = await report(ctx.base, {
      event_code: event.event_code,
      round: 1,
      pairing_id: normal.pairing_id,
      seat: "loyalist",
      loyalist_vp: 10,
      traitor_vp: 4,
      outcome: "loyalist_win",
      note: "Held the gate"
    });
    const rightBody = await right.json();
    assert.equal(right.status, 201, JSON.stringify(rightBody));
    assert.equal(rightBody.status, "pending");
    assert.equal(JSON.stringify(rightBody).includes(event.event_code), false);

    for (let i = 0; i < 3; i++) {
      const again = await report(ctx.base, { event_code: "BAD-CODE", round: 1 });
      assert.equal(again.status, 401);
    }
    const limited = await report(ctx.base, { event_code: event.event_code, round: 1, pairing_id: normal.pairing_id, seat: "traitor", loyalist_vp: 10, traitor_vp: 4, outcome: "loyalist_win" });
    const limitedText = await limited.text();
    assert.equal(limited.status, 429);
    assert.equal(limitedText.includes(event.event_code), false);
  } finally {
    await ctx.stop();
  }
});

test("a published table can be reported, including a locked match, and a bye cannot", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers: auth.headers })).json();
    const { round, grudge, normal, bye } = await setup(ctx.base, auth.headers);
    await publish(ctx.base, auth.headers, round.round_id);
    const listed = await (await fetch(ctx.base + "/api/report?round=1&event=" + encodeURIComponent(event.event_code))).json();
    assert.deepEqual(listed.games.map((game) => game.table), ["1", "2"]);
    assert.equal(listed.games.some((game) => game.kind === "grudge"), true);
    assert.equal(JSON.stringify(listed).includes(event.event_code), false);
    const other = await report(ctx.base, {
      event_code: event.event_code,
      round: 2,
      pairing_id: normal.pairing_id,
      seat: "loyalist",
      loyalist_vp: 5,
      traitor_vp: 5,
      outcome: "tie"
    });
    assert.equal(other.status, 404);
    const missingTable = await report(ctx.base, {
      event_code: event.event_code,
      round: 1,
      pairing_id: 999,
      seat: "loyalist",
      loyalist_vp: 5,
      traitor_vp: 5,
      outcome: "tie"
    });
    assert.equal(missingTable.status, 400);
    assert.match((await missingTable.json()).error, /not in this round/);
    const byeReport = await report(ctx.base, {
      event_code: event.event_code,
      round: 1,
      pairing_id: bye.pairing_id,
      seat: "loyalist",
      loyalist_vp: 10,
      traitor_vp: null,
      outcome: "bye"
    });
    assert.equal(byeReport.status, 400);
    assert.match((await byeReport.json()).error, /bye/i);
    const phone = await report(ctx.base, {
      event_code: event.event_code,
      round: 1,
      pairing_id: normal.pairing_id,
      seat: "loyalist",
      loyalist_vp: 6,
      traitor_vp: 6,
      outcome: "tie",
      note: "pilot@example.com"
    });
    assert.equal(phone.status, 400);
    assert.match((await phone.json()).error, /email address or a phone number/);
    const locked = await report(ctx.base, {
      event_code: event.event_code,
      round: 1,
      pairing_id: grudge.pairing_id,
      seat: "traitor",
      loyalist_vp: 4,
      traitor_vp: 11,
      outcome: "traitor_win",
      note: "The gate held"
    });
    const lockedBody = await locked.json();
    assert.equal(locked.status, 201, JSON.stringify(lockedBody));
    assert.equal(lockedBody.status, "pending");
    assert.equal(grudge.locked, true);
  } finally {
    await ctx.stop();
  }
});

test("matching reports confirm, a clash is flagged, and the organiser confirms or rejects", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers: auth.headers })).json();
    const code = event.event_code;
    const { round, grudge, normal } = await setup(ctx.base, auth.headers);
    await publish(ctx.base, auth.headers, round.round_id);
    const agreedFirst = await report(ctx.base, {
      event_code: code, round: 1, pairing_id: grudge.pairing_id, seat: "loyalist",
      loyalist_vp: 9, traitor_vp: 2, outcome: "loyalist_win", note: "The gate held"
    });
    assert.equal(agreedFirst.status, 201);
    const agreedSecond = await report(ctx.base, {
      event_code: code, round: 1, pairing_id: grudge.pairing_id, seat: "traitor",
      loyalist_vp: 9, traitor_vp: 2, outcome: "loyalist_win"
    });
    const agreedBody = await agreedSecond.json();
    assert.equal(agreedSecond.status, 200, JSON.stringify(agreedBody));
    assert.equal(agreedBody.status, "confirmed");
    const agreedRow = (await (await fetch(ctx.base + "/api/results", { headers: auth.headers })).json())
      .find((row) => Number(row.pairing_id) === Number(grudge.pairing_id));
    assert.equal(agreedRow.confirmation, "confirmed");
    assert.equal(agreedRow.confirmed_by, "opponent");
    const first = await report(ctx.base, {
      event_code: code, round: 1, pairing_id: normal.pairing_id, seat: "loyalist",
      loyalist_vp: 8, traitor_vp: 8, outcome: "tie", note: "A quiet table"
    });
    assert.equal(first.status, 201);
    const repeat = await report(ctx.base, {
      event_code: code, round: 1, pairing_id: normal.pairing_id, seat: "loyalist",
      loyalist_vp: 8, traitor_vp: 8, outcome: "tie"
    });
    assert.equal(repeat.status, 409);
    const clash = await report(ctx.base, {
      event_code: code, round: 1, pairing_id: normal.pairing_id, seat: "traitor",
      loyalist_vp: 3, traitor_vp: 12, outcome: "traitor_win", note: "We took it"
    });
    const clashBody = await clash.json();
    assert.equal(clash.status, 200, JSON.stringify(clashBody));
    assert.equal(clashBody.status, "disputed");
    const hidden = await (await fetch(ctx.base + "/api/results")).json();
    assert.equal(hidden.some((row) => Number(row.pairing_id) === Number(normal.pairing_id)), false);
    assert.equal(hidden.every((row) => row.confirmation === "confirmed"), true);
    const adminRows = await (await fetch(ctx.base + "/api/results", { headers: auth.headers })).json();
    const disputed = adminRows.find((row) => Number(row.pairing_id) === Number(normal.pairing_id));
    assert.equal(disputed.confirmation, "disputed");
    assert.equal(disputed.counter_outcome, "traitor_win");
    assert.equal(disputed.counter_traitor_vp, 12);

    const anon = await fetch(ctx.base + "/api/results/" + disputed.result_id + "/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(anon.status, 401);
    const noCsrf = await fetch(ctx.base + "/api/results/" + disputed.result_id + "/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        Cookie: "sh_session=" + auth.cookie
      },
      body: "{}"
    });
    assert.equal(noCsrf.status, 403);
    const saved = await fetch(ctx.base + "/api/results/" + disputed.result_id, {
      method: "PUT",
      headers: auth.headers,
      body: JSON.stringify({ ...disputed, loyalist_vp: 8, traitor_vp: 8, outcome: null, confirmation: "disputed" })
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const confirmed = await fetch(ctx.base + "/api/results/" + disputed.result_id + "/confirm", {
      method: "POST",
      headers: { ...auth.headers, Cookie: "sh_session=" + auth.cookie },
      body: "{}"
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const visible = await (await fetch(ctx.base + "/api/results")).json();
    const shown = visible.find((row) => Number(row.pairing_id) === Number(normal.pairing_id));
    assert.ok(shown);
    assert.equal(shown.confirmation, "confirmed");
    assert.equal(shown.outcome, "tie");
    assert.equal(shown.counter_outcome, undefined);
    assert.equal(JSON.stringify(visible).includes(code), false);

    const rejected = await fetch(ctx.base + "/api/results/" + agreedRow.result_id + "/reject", {
      method: "POST",
      headers: auth.headers,
      body: "{}"
    });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 200, JSON.stringify(rejectedBody));
    assert.equal(rejectedBody.confirmation, "disputed");
    const still = await (await fetch(ctx.base + "/api/results")).json();
    assert.equal(still.some((row) => Number(row.pairing_id) === Number(grudge.pairing_id)), false);
    assert.equal(still.some((row) => Number(row.pairing_id) === Number(normal.pairing_id)), true);
  } finally {
    await ctx.stop();
  }
});
