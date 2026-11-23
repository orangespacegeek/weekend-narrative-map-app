"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer(dataDir, extra) {
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
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
      ...extra
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
    log: () => log,
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
  return { "Content-Type": "application/json", Authorization: "Bearer " + json.token };
}

async function send(base, headers, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { error: text };
  }
  return { status: res.status, json };
}

test("boot migrates the imported map and hides the event code and QR token", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-model-"));
  const ctx = startServer(dataDir);
  try {
    await ctx.ready;
    assert.match(ctx.log(), /Migrated \d+ areas from systems.json/);
    const systems = JSON.parse(fs.readFileSync(path.join(dataDir, "systems.json"), "utf8"));
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline", "systems.json"), "utf8"));
    assert.deepEqual(systems, baseline);
    const map = JSON.parse(fs.readFileSync(path.join(dataDir, "map.json"), "utf8"));
    assert.equal(map.areas[0].area_id, 1);
    assert.equal(map.areas[0].name, "Crossing");
    assert.deepEqual(map.areas[0].routes, [2, 3, 4]);
    assert.equal(map.areas[0].sys_id, undefined);
    assert.equal(fs.existsSync(path.join(dataDir, "players.json")), false);

    const event = await send(ctx.base, {}, "GET", "/api/public/event");
    assert.equal(event.status, 200);
    assert.equal(event.json.name, "Weekend Event");
    assert.equal(event.json.event_code, undefined);
    assert.deepEqual(event.json.scoring, { win: 3, tie: 1, loss: 0, bye_vp: 10 });
    assert.equal(event.json.control_tie, "previous_holder");

    const headers = await admin(ctx.base);
    const full = await send(ctx.base, headers, "GET", "/api/event");
    assert.equal(full.status, 200);
    assert.equal(typeof full.json.event_code, "string");
    assert.ok(full.json.event_code.length >= 8);

    const round = await send(ctx.base, headers, "POST", "/api/rounds", { number: 1, state: "draft" });
    assert.equal(round.status, 201, JSON.stringify(round.json));
    const hidden = await send(ctx.base, {}, "GET", "/api/rounds");
    assert.equal(hidden.json[0].qr_token, undefined);
    const seen = await send(ctx.base, headers, "GET", "/api/rounds/" + round.json.round_id);
    assert.equal(typeof seen.json.qr_token, "string");
  } finally {
    await ctx.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("admin CRUD covers entrants, locked matches, results, and area control", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-crud-"));
  const ctx = startServer(dataDir);
  try {
    await ctx.ready;
    const headers = await admin(ctx.base);
    const denied = await send(ctx.base, { "Content-Type": "application/json" }, "POST", "/api/players", {
      display_name: "L-01",
      faction: "Loyalist"
    });
    assert.equal(denied.status, 401);

    const contact = await send(ctx.base, headers, "POST", "/api/players", {
      display_name: "L-01",
      faction: "Loyalist",
      email: "someone@example.com"
    });
    assert.equal(contact.status, 400);

    const loyal = await send(ctx.base, headers, "POST", "/api/players", {
      display_name: "L-01",
      faction: "Loyalist",
      bye: true
    });
    const traitor = await send(ctx.base, headers, "POST", "/api/players", {
      display_name: "T-01",
      faction: "Traitor"
    });
    assert.equal(loyal.status, 201, JSON.stringify(loyal.json));
    assert.equal(traitor.status, 201, JSON.stringify(traitor.json));
    const dup = await send(ctx.base, headers, "POST", "/api/players", { display_name: "l-01", faction: "Loyalist" });
    assert.equal(dup.status, 409);

    const pub = await send(ctx.base, {}, "GET", "/api/public/entrants");
    assert.equal(pub.json[0].display_name, "L-01");
    assert.equal(pub.json[0].bye, undefined);
    assert.equal(JSON.stringify(pub.json).includes("@"), false);

    const round = (await send(ctx.base, headers, "POST", "/api/rounds", { number: 1 })).json;
    const early = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "normal",
      state: "published",
      loyalist_id: loyal.json.player_id,
      traitor_id: traitor.json.player_id
    });
    assert.equal(early.status, 400);

    const pairing = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "grudge",
      locked: false,
      state: "draft",
      table: "4",
      area_id: 1,
      loyalist_id: loyal.json.player_id,
      traitor_id: traitor.json.player_id
    });
    assert.equal(pairing.status, 400);

    const created = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "grudge",
      state: "draft",
      table: "4",
      area_id: 1,
      loyalist_id: loyal.json.player_id,
      traitor_id: traitor.json.player_id
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.locked, true);

    const again = await send(ctx.base, headers, "POST", "/api/pairings", {
      round_id: round.round_id,
      kind: "normal",
      state: "draft",
      loyalist_id: loyal.json.player_id,
      traitor_id: traitor.json.player_id
    });
    assert.equal(again.status, 400);

    const approved = await send(ctx.base, headers, "PUT", "/api/pairings/" + created.json.pairing_id, { state: "approved" });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    const published = await send(ctx.base, headers, "PUT", "/api/pairings/" + created.json.pairing_id, { state: "published" });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    const visitors = await send(ctx.base, {}, "GET", "/api/pairings");
    assert.equal(visitors.json.length, 1);

    const lowBye = await send(ctx.base, headers, "POST", "/api/results", {
      pairing_id: created.json.pairing_id,
      round_id: round.round_id,
      loyalist_vp: 4,
      traitor_vp: 2
    });
    assert.equal(lowBye.status, 201, JSON.stringify(lowBye.json));
    assert.equal(lowBye.json.outcome, "loyalist_win");
    assert.deepEqual(lowBye.json.campaign_points, { loyalist: 3, traitor: 0 });

    const opponent = await send(ctx.base, headers, "POST", "/api/results/" + lowBye.json.result_id + "/confirm", {
      as: "opponent"
    });
    assert.equal(opponent.status, 409);
    const confirmed = await send(ctx.base, headers, "POST", "/api/results/" + lowBye.json.result_id + "/confirm", {
      as: "admin"
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.confirmation, "confirmed");
    assert.equal(confirmed.json.confirmed_by, "admin");

    const image = await send(ctx.base, headers, "PUT", "/api/map", { image: { file: "beta-garmon-ii-map.jpg", width: 800, height: 1000 } });
    assert.equal(image.status, 200, JSON.stringify(image.json));
    assert.equal(image.json.image.file, "beta-garmon-ii-map.jpg");
    const badImage = await send(ctx.base, headers, "PUT", "/api/map", { image: { file: "../secret.png" } });
    assert.equal(badImage.status, 400);

    const outline = await send(ctx.base, headers, "POST", "/api/areas", {
      name: "Hab Block",
      shape: "outline",
      x: 100,
      y: 100,
      points: [
        { x: 10, y: 10 },
        { x: 40, y: 10 },
        { x: 20, y: 40 }
      ],
      tables: ["12", "13"],
      scenario: "Hab fight",
      routes: [1]
    });
    assert.equal(outline.status, 201, JSON.stringify(outline.json));
    assert.deepEqual(outline.json.tables, ["12", "13"]);

    const control = await send(ctx.base, headers, "POST", "/api/control", {
      round_id: round.round_id,
      area_id: 1,
      loyalist_points: 3,
      traitor_points: 0,
      previous_controller: "neutral"
    });
    assert.equal(control.status, 201, JSON.stringify(control.json));
    assert.equal(control.json.controller, "Loyalist");
    const flip = await send(ctx.base, headers, "POST", "/api/control", {
      round_id: round.round_id,
      area_id: 1,
      loyalist_points: 0,
      traitor_points: 0,
      controller: "Traitor"
    });
    assert.equal(flip.status, 400);
  } finally {
    await ctx.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stored campaign_admin role is accepted and rewritten to event_admin", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-role-"));
  const first = startServer(dataDir);
  try {
    await first.ready;
  } finally {
    await first.stop();
  }
  const accountsPath = path.join(dataDir, "accounts.json");
  const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
  accounts[0].role = "campaign_admin";
  fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
  const second = startServer(dataDir, { CAMPAIGN_ADMIN_FORCE_PASSWORD: "" });
  try {
    await second.ready;
    const rewritten = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
    assert.equal(rewritten[0].role, "event_admin");
    const headers = await admin(second.base);
    const me = await send(second.base, headers, "GET", "/api/auth/me");
    assert.equal(me.json.role, "event_admin");
  } finally {
    await second.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
