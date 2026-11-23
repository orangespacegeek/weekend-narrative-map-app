"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-backup-"));
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
    dataDir,
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

test("backup, csv export, and restore stay behind the admin and CSRF checks", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const event = await (await fetch(ctx.base + "/api/event", { headers: auth.headers })).json();
    const routes = ["/api/admin/backup", "/api/admin/standings.csv", "/api/admin/results.csv"];
    for (const route of routes) {
      const anon = await fetch(ctx.base + route);
      const anonText = await anon.text();
      assert.equal(anon.status, 401, route);
      assert.equal(anonText.includes(event.event_code), false, route);
      assert.equal(anonText.includes("weekend-event-backup"), false, route);
      const noCsrf = await fetch(ctx.base + route, {
        headers: { Authorization: "Bearer " + auth.token, Cookie: "sh_session=" + auth.cookie }
      });
      assert.equal(noCsrf.status, 403, route);
    }
    const restoreAnon = await fetch(ctx.base + "/api/admin/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(restoreAnon.status, 401);
    const restoreCookie = await fetch(ctx.base + "/api/admin/restore", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        Cookie: "sh_session=" + auth.cookie
      },
      body: "{}"
    });
    assert.equal(restoreCookie.status, 403);
    const csv = await (await fetch(ctx.base + "/api/admin/standings.csv", { headers: auth.headers })).text();
    assert.match(csv, /display_name/);
    assert.equal(csv.includes(event.event_code), false);
  } finally {
    await ctx.stop();
  }
});

test("a backup round-trips, and a bad restore leaves the event alone", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const headers = auth.headers;
    const created = await (await fetch(ctx.base + "/api/players", {
      method: "POST", headers,
      body: JSON.stringify({ display_name: "L-01", faction: "Loyalist", army: "Iron Hands" })
    })).json();
    const uploaded = await fetch(ctx.base + "/api/map/image", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth.token, "Content-Type": "image/png", "X-SH-Request": "1" },
      body: PNG
    });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const saved = await (await fetch(ctx.base + "/api/admin/backup", { headers })).json();
    assert.equal(saved.format, "weekend-event-backup");
    assert.equal(saved.map_image.mime, "image/png");
    assert.equal(saved.files["players.json"][0].display_name, "L-01");
    assert.equal(saved.files.accounts, undefined);

    await fetch(ctx.base + "/api/players/" + created.player_id, {
      method: "PUT", headers,
      body: JSON.stringify({ display_name: "L-99", faction: "Loyalist", army: "Iron Hands" })
    });
    const bad = await fetch(ctx.base + "/api/admin/restore", {
      method: "POST", headers,
      body: JSON.stringify({ format: "weekend-event-backup", version: 1, files: { "players.json": "nope" } })
    });
    assert.equal(bad.status, 400);
    const still = await (await fetch(ctx.base + "/api/players", { headers })).json();
    assert.equal(still[0].display_name, "L-99");
    assert.equal(fs.readFileSync(path.join(ctx.dataDir, "maps", "event-map.png")).equals(PNG), true);

    const restored = await fetch(ctx.base + "/api/admin/restore", {
      method: "POST", headers,
      body: JSON.stringify(saved)
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    const back = await (await fetch(ctx.base + "/api/players", { headers })).json();
    assert.equal(back[0].display_name, "L-01");
    assert.equal(fs.readFileSync(path.join(ctx.dataDir, "maps", "event-map.png")).equals(PNG), true);
    const results = await (await fetch(ctx.base + "/api/admin/results.csv", { headers })).text();
    assert.match(results, /loyalist/);
    assert.equal(results.includes("email"), false);
  } finally {
    await ctx.stop();
  }
});
