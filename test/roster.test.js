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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-roster-"));
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
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
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
  assert.equal(res.status, 200, JSON.stringify(json));
  return { Authorization: "Bearer " + json.token, "Content-Type": "application/json" };
}

async function send(base, headers, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { error: text }; }
  return { status: res.status, json };
}

test("roster import is admin-only and the public list has no contact fields", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const denied = await send(ctx.base, { "Content-Type": "application/json" }, "POST", "/api/players/import", {
      text: "L-01, Loyalist, Iron Hands"
    });
    assert.equal(denied.status, 401);
    const headers = await admin(ctx.base);
    const contact = await send(ctx.base, headers, "POST", "/api/players", {
      display_name: "L-01",
      faction: "Loyalist",
      email: "a@b.c"
    });
    assert.equal(contact.status, 400);
    const sheet = await send(ctx.base, headers, "POST", "/api/players/import", {
      text: "Name,Faction,Email\nL-01,Loyalist,a@b.c"
    });
    assert.equal(sheet.status, 400);
    const imported = await send(ctx.base, headers, "POST", "/api/players/import", {
      text: "display name,faction,army\nL-01,Loyalist,Iron Hands\nT-01,Traitor,Night Lords"
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.json));
    assert.equal(imported.json.added.length, 2);
    const pub = await (await fetch(ctx.base + "/api/public/entrants")).json();
    assert.equal(pub.length, 2);
    assert.equal(pub.some((row) => row.display_name === "L-01" && row.army === "Iron Hands" && row.faction === "Loyalist"), true);
    assert.equal(JSON.stringify(pub).includes("email"), false);
    assert.equal(JSON.stringify(pub).includes("bye"), false);
  } finally {
    await ctx.stop();
  }
});

test("drops keep history, and Apex or Grudge matches lock and reject clashes", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const added = await send(ctx.base, headers, "POST", "/api/players/import", {
      text: "L-01,Loyalist\nL-02,Loyalist\nT-01,Traitor\nT-02,Traitor"
    });
    assert.equal(added.status, 201, JSON.stringify(added.json));
    const byName = Object.fromEntries(added.json.added.map((row) => [row.display_name, row.player_id]));
    const round = (await send(ctx.base, headers, "POST", "/api/rounds", { number: 1 })).json;
    const apex = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "apex",
      state: "draft",
      loyalist_id: byName["L-01"],
      traitor_id: byName["T-01"]
    });
    assert.equal(apex.status, 201, JSON.stringify(apex.json));
    assert.equal(apex.json.locked, true);
    const sameRound = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "grudge",
      state: "draft",
      loyalist_id: byName["L-01"],
      traitor_id: byName["T-02"]
    });
    assert.equal(sameRound.status, 400);
    assert.match(sameRound.json.error, /already in a match/);
    const round2 = (await send(ctx.base, headers, "POST", "/api/rounds", { number: 2 })).json;
    const rematch = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round2.round_id,
      kind: "grudge",
      state: "draft",
      loyalist_id: byName["L-01"],
      traitor_id: byName["T-01"]
    });
    assert.equal(rematch.status, 400);
    assert.match(rematch.json.error, /already been paired/);
    const side = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round2.round_id,
      kind: "apex",
      state: "draft",
      loyalist_id: byName["T-02"],
      traitor_id: byName["L-02"]
    });
    assert.equal(side.status, 400);

    const dropped = await send(ctx.base, headers, "PUT", "/api/players/" + byName["L-02"], {
      display_name: "L-02",
      faction: "Loyalist",
      dropped: true
    });
    assert.equal(dropped.status, 200, JSON.stringify(dropped.json));
    const still = await send(ctx.base, headers, "GET", "/api/pairings");
    assert.equal(still.json.some((row) => row.pairing_id === apex.json.pairing_id), true);
    const later = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round2.round_id,
      kind: "grudge",
      state: "draft",
      loyalist_id: byName["L-02"],
      traitor_id: byName["T-02"]
    });
    assert.equal(later.status, 400);
    assert.match(later.json.error, /dropped/);
    const removed = await send(ctx.base, headers, "DELETE", "/api/players/" + byName["L-01"]);
    assert.equal(removed.status, 409);
  } finally {
    await ctx.stop();
  }
});
