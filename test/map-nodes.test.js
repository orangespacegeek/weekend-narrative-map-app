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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-map-"));
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

test("an admin can edit nodes and routes, and control totals are not stored", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const visitor = await fetch(ctx.base + "/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sys_name: "Nope" })
    });
    assert.equal(visitor.status, 401);

    const login = await fetch(ctx.base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", password: ADMIN_PW })
    });
    const token = (await login.json()).token;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer " + token };

    const created = await fetch(ctx.base + "/api/systems", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sys_name: "Relay",
        sys_x: 100,
        sys_y: 120,
        sys_links: "1",
        sys_notes: "A new junction",
        sys_loyal: 9,
        sys_traitor: 4,
        sys_controller: "Loyalist",
        sys_power: 5
      })
    });
    const node = await created.json();
    assert.equal(created.status, 201, JSON.stringify(node));
    assert.equal(node.sys_name, "Relay");
    assert.equal(node.sys_links, "1");
    assert.equal(node.sys_loyal, undefined);
    assert.equal(node.sys_traitor, undefined);
    assert.equal(node.sys_controller, undefined);
    assert.equal(node.sys_power, undefined);

    const updated = await fetch(ctx.base + "/api/systems/" + node.sys_id, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...node, sys_name: "Relay Post", sys_links: "1,6" })
    });
    const saved = await updated.json();
    assert.equal(updated.status, 200, JSON.stringify(saved));
    assert.equal(saved.sys_name, "Relay Post");
    assert.equal(saved.sys_links, "1,6");

    const removed = await fetch(ctx.base + "/api/systems/1", { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    const map = await (await fetch(ctx.base + "/api/public/systems")).json();
    const relay = map.find((row) => row.sys_name === "Relay Post");
    assert.ok(relay);
    assert.equal(relay.sys_links.includes("1"), false);
    assert.equal(map.some((row) => Number(row.sys_id) === 1), false);
  } finally {
    await ctx.stop();
  }
});
