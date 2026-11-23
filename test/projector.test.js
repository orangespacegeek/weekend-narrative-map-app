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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-proj-"));
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

test("the projector shows only confirmed published games and never the event code", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers: auth.headers })).json();
    const loyal = await (await fetch(ctx.base + "/api/players", {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "Iron Hands" })
    })).json();
    const traitor = await (await fetch(ctx.base + "/api/players", {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({ display_name: "T-01", faction: "Traitor", army: "Night Lords" })
    })).json();
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST", headers: auth.headers, body: JSON.stringify({ number: 1 })
    })).json();
    const areas = await (await fetch(ctx.base + "/api/areas")).json();
    const pairing = await (await fetch(ctx.base + "/api/pairings", {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({
        round_id: round.round_id, kind: "apex", state: "draft", area_id: areas[0].area_id, table: "1",
        loyalist_id: loyal.player_id, traitor_id: traitor.player_id
      })
    })).json();
    await fetch(ctx.base + "/api/results", {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({
        pairing_id: pairing.pairing_id, round_id: round.round_id,
        loyalist_vp: 11, traitor_vp: 3, reported_by: "admin", confirmation: "confirmed", confirmed_by: "admin",
        note: "SECRET-PENDING-NOTE"
      })
    });
    const hidden = await (await fetch(ctx.base + "/api/projector")).json();
    assert.equal(hidden.current_round, 0);
    assert.equal(JSON.stringify(hidden).includes("SECRET-PENDING-NOTE"), false);
    assert.equal(JSON.stringify(hidden).includes(event.event_code), false);
    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers: auth.headers, body: "{}" });
    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers: auth.headers, body: "{}" });
    const result = (await (await fetch(ctx.base + "/api/results", { headers: auth.headers })).json())[0];
    await fetch(ctx.base + "/api/results/" + result.result_id, {
      method: "PUT", headers: auth.headers,
      body: JSON.stringify({ ...result, confirmation: "pending", note: "SECRET-PENDING-NOTE" })
    });
    const pending = await (await fetch(ctx.base + "/api/projector")).json();
    assert.equal(JSON.stringify(pending).includes("SECRET-PENDING-NOTE"), false);
    assert.equal(pending.factions.Loyalist.campaign_points, 0);
    await fetch(ctx.base + "/api/results/" + result.result_id, {
      method: "PUT", headers: auth.headers,
      body: JSON.stringify({
        pairing_id: pairing.pairing_id, round_id: round.round_id,
        loyalist_vp: 11, traitor_vp: 3, outcome: "loyalist_win",
        confirmation: "confirmed", reported_by: "admin", confirmed_by: "admin", note: "The wall held"
      })
    });
    const live = await (await fetch(ctx.base + "/api/projector")).json();
    const page = await (await fetch(ctx.base + "/projector")).text();
    assert.equal(live.current_round, 1);
    assert.equal(live.best.loyalist.display_name, "L-01");
    assert.equal(live.best.loyalist.army, "Iron Hands");
    assert.equal(live.factions.Loyalist.campaign_points, 3);
    assert.ok(live.highlights.some((line) => line.includes("The wall held")));
    assert.equal(JSON.stringify(live).includes(event.event_code), false);
    assert.equal(JSON.stringify(live).includes("qr_token"), false);
    assert.equal(JSON.stringify(live).includes("qr.svg"), false);
    assert.equal(page.includes(event.event_code), false);
    assert.equal(page.includes("<nav"), false);
    const script = await (await fetch(ctx.base + "/js/projector.js")).text();
    assert.match(script, /setInterval\(load, 30000\)/);
  } finally {
    await ctx.stop();
  }
});

test("the site theme is an admin setting", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const anon = await fetch(ctx.base + "/api/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "journal-tactica" })
    });
    assert.equal(anon.status, 401);
    const noCsrf = await fetch(ctx.base + "/api/theme", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        Cookie: "sh_session=" + auth.cookie
      },
      body: JSON.stringify({ theme: "journal-tactica" })
    });
    assert.equal(noCsrf.status, 403);
    const bad = await fetch(ctx.base + "/api/theme", {
      method: "POST", headers: auth.headers,
      body: JSON.stringify({ theme: "neon" })
    });
    assert.equal(bad.status, 400);
    const saved = await fetch(ctx.base + "/api/theme", {
      method: "POST",
      headers: { ...auth.headers, Cookie: "sh_session=" + auth.cookie },
      body: JSON.stringify({ theme: "journal-tactica" })
    });
    assert.equal(saved.status, 200);
    const pub = await (await fetch(ctx.base + "/api/public/event")).json();
    assert.equal(pub.theme, "journal-tactica");
    assert.equal(pub.event_code, undefined);
    const page = await (await fetch(ctx.base + "/standings.html")).text();
    assert.match(page, /data-site-theme="journal-tactica"/);
  } finally {
    await ctx.stop();
  }
});
