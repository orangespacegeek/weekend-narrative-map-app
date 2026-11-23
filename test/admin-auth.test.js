"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

function startServer(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-auth-"));
  const port = 41000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      CAMPAIGN_ADMIN_PASSWORD: ADMIN_PW,
      CAMPAIGN_ADMIN_FORCE_PASSWORD: "1",
      TRUST_PROXY: "",
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

async function login(base, password) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password })
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("only the event admin can sign in, and player auth routes are gone", async () => {
  const ctx = startServer({ NODE_ENV: "development" });
  try {
    await ctx.ready;
    const signup = await fetch(ctx.base + "/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "someone", password: "secret" })
    });
    assert.equal(signup.status, 404);
    const invites = await fetch(ctx.base + "/api/auth/invites");
    assert.equal(invites.status, 404);
    const forces = await fetch(ctx.base + "/api/forces");
    assert.equal(forces.status, 404);
    const actions = await fetch(ctx.base + "/api/actions");
    assert.equal(actions.status, 404);

    const bad = await login(ctx.base, "nope");
    assert.equal(bad.status, 401);

    const good = await login(ctx.base, ADMIN_PW);
    assert.equal(good.status, 200);
    assert.equal(good.json.role, "campaign_admin");
    assert.equal(good.json.authenticated, undefined);
    assert.ok(good.json.token);

    const me = await fetch(ctx.base + "/api/auth/me", {
      headers: { Authorization: "Bearer " + good.json.token }
    });
    const meJson = await me.json();
    assert.equal(me.status, 200);
    assert.equal(meJson.authenticated, true);
    assert.equal(meJson.role, "campaign_admin");
    assert.equal(meJson.player_id, undefined);

    const anon = await fetch(ctx.base + "/api/auth/me");
    assert.deepEqual(await anon.json(), { authenticated: false, role: "visitor" });
  } finally {
    await ctx.stop();
  }
});

test("production rejects the old published admin password", async () => {
  const ctx = startServer({ NODE_ENV: "production" });
  try {
    await ctx.ready;
    const rejected = await login(ctx.base, "change-me");
    assert.equal(rejected.status, 401);
    assert.match(rejected.json.error, /no longer accepted/);
  } finally {
    await ctx.stop();
  }
});
