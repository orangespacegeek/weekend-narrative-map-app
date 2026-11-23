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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-results-"));
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

async function adminToken(base) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password: ADMIN_PW })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.token;
}

function auth(token) {
  return { "Content-Type": "application/json", Authorization: "Bearer " + token };
}

test("a side-reported result waits for the opponent, and an admin report does not", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const denied = await fetch(ctx.base + "/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side_a: "North", side_b: "South", sys_id: 1, result: "side_a_win", reported_by: "side_a" })
    });
    assert.equal(denied.status, 401);

    const token = await adminToken(ctx.base);
    const created = await fetch(ctx.base + "/api/games", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        side_a: "North",
        side_b: "South",
        sys_id: 1,
        result: "side_a_win",
        side_a_vp: 12,
        side_b_vp: 8,
        reported_by: "side_a",
        mission: "Hold the crossing"
      })
    });
    const game = await created.json();
    assert.equal(created.status, 201, JSON.stringify(game));
    assert.equal(game.result_state, "pending");
    assert.equal(game.reported_by, "side_a");
    assert.equal(game.confirmed_by, null);
    assert.equal(game.resolution, undefined);
    assert.equal(game.attacker_id, undefined);

    const opp = await fetch(ctx.base + "/api/games/" + game.game_id + "/confirm", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ as: "opponent" })
    });
    const confirmed = await opp.json();
    assert.equal(opp.status, 200, JSON.stringify(confirmed));
    assert.equal(confirmed.result_state, "confirmed");
    assert.equal(confirmed.confirmed_by, "opponent");

    const adminReport = await fetch(ctx.base + "/api/games", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        side_a: "East",
        side_b: "West",
        sys_id: 3,
        result: "draw",
        reported_by: "admin"
      })
    });
    const second = await adminReport.json();
    assert.equal(second.result_state, "pending");
    const blocked = await fetch(ctx.base + "/api/games/" + second.game_id + "/confirm", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ as: "opponent" })
    });
    assert.equal(blocked.status, 409);
    const asAdmin = await fetch(ctx.base + "/api/games/" + second.game_id + "/confirm", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ as: "admin" })
    });
    const adminConfirmed = await asAdmin.json();
    assert.equal(asAdmin.status, 200, JSON.stringify(adminConfirmed));
    assert.equal(adminConfirmed.confirmed_by, "admin");

    const third = await (
      await fetch(ctx.base + "/api/games", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          side_a: "High",
          side_b: "Low",
          sys_id: 5,
          result: "side_b_win",
          reported_by: "side_b"
        })
      })
    ).json();
    const dispute = await fetch(ctx.base + "/api/games/" + third.game_id + "/dispute", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({ note: "Scores do not match" })
    });
    const disputed = await dispute.json();
    assert.equal(dispute.status, 200, JSON.stringify(disputed));
    assert.equal(disputed.result_state, "disputed");
    assert.equal(disputed.dispute_note, "Scores do not match");

    const cleared = await fetch(ctx.base + "/api/games/" + third.game_id + "/void", {
      method: "POST",
      headers: auth(token),
      body: "{}"
    });
    const open = await cleared.json();
    assert.equal(cleared.status, 200, JSON.stringify(open));
    assert.equal(open.result_state, "open");
    assert.equal(open.result, "in_progress");

    const pub = await (await fetch(ctx.base + "/api/public/games")).json();
    assert.equal(pub.some((row) => row.side_a === "North" && row.result_state === "confirmed"), true);
    assert.equal(JSON.stringify(pub).includes("pass_hash"), false);
  } finally {
    await ctx.stop();
  }
});
