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
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABQEBAQAAAAAAAAAAAAAAAAAABQYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCEAnzj/9k=",
  "base64"
);

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
    dataDir,
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

async function token(base) {
  const res = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "admin", password: ADMIN_PW })
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.token;
}

test("only the admin can upload a PNG or JPEG, and the public map serves it", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const denied = await fetch(ctx.base + "/api/map/image", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG
    });
    assert.equal(denied.status, 401);

    const auth = await token(ctx.base);
    const bad = await fetch(ctx.base + "/api/map/image", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth, "Content-Type": "image/gif" },
      body: Buffer.from("GIF89a")
    });
    assert.equal(bad.status, 400);

    const png = await fetch(ctx.base + "/api/map/image", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth, "Content-Type": "image/png" },
      body: PNG
    });
    const pngJson = await png.json();
    assert.equal(png.status, 201, JSON.stringify(pngJson));
    assert.equal(pngJson.image.file, "event-map.png");
    assert.equal(pngJson.image.width, 1);
    assert.equal(pngJson.image.height, 1);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, "maps", "event-map.png")), true);

    const jpeg = await fetch(ctx.base + "/api/map/image", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth, "Content-Type": "image/jpeg" },
      body: JPEG
    });
    const jpegJson = await jpeg.json();
    assert.equal(jpeg.status, 201, JSON.stringify(jpegJson));
    assert.equal(jpegJson.image.file, "event-map.jpg");
    assert.equal(jpegJson.image.width, 2);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, "maps", "event-map.png")), false);

    const file = await fetch(ctx.base + "/api/map/image");
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") || "", /jpeg/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);

    const slipped = await fetch(ctx.base + "/api/map", {
      method: "PUT",
      headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({ image: { file: "../event-map.jpg" } })
    });
    assert.equal(slipped.status, 400);
  } finally {
    await ctx.stop();
  }
});

test("area saves are admin-only and the public map reports this round's controller", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await token(ctx.base);
    const headers = { Authorization: "Bearer " + auth, "Content-Type": "application/json" };
    const visitor = await fetch(ctx.base + "/api/map", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ areas: [] })
    });
    assert.equal(visitor.status, 401);

    const broken = await fetch(ctx.base + "/api/map", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        areas: [{ area_id: 1, name: "Wall", shape: "outline", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], routes: [] }]
      })
    });
    assert.equal(broken.status, 400);

    const missing = await fetch(ctx.base + "/api/map", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        areas: [{
          area_id: 1,
          name: "Wall",
          shape: "outline",
          x: 100,
          y: 100,
          points: [{ x: 10, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 80 }, { x: 10, y: 80 }],
          routes: [9]
        }]
      })
    });
    assert.equal(missing.status, 400);

    const saved = await fetch(ctx.base + "/api/map", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        areas: [
          {
            area_id: 1,
            name: "Wall",
            shape: "outline",
            x: 100,
            y: 80,
            points: [{ x: 10, y: 10 }, { x: 80, y: 10 }, { x: 80, y: 80 }, { x: 10, y: 80 }],
            tables: ["3"],
            scenario: "Reactor Defense",
            routes: [2]
          },
          {
            area_id: 2,
            name: "Gate",
            shape: "outline",
            x: 200,
            y: 80,
            points: [{ x: 120, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 80 }, { x: 120, y: 80 }],
            routes: [1]
          }
        ]
      })
    });
    const map = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(map));
    assert.equal(map.areas[0].controller, "neutral");
    assert.equal(map.areas[0].scenario, "Reactor Defense");

    const round1 = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    await fetch(ctx.base + "/api/control", {
      method: "POST",
      headers,
      body: JSON.stringify({
        round_id: round1.round_id,
        area_id: 1,
        loyalist_points: 3,
        traitor_points: 0,
        previous_controller: "neutral"
      })
    });
    const round2 = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 2 })
    })).json();
    await fetch(ctx.base + "/api/control", {
      method: "POST",
      headers,
      body: JSON.stringify({
        round_id: round2.round_id,
        area_id: 1,
        loyalist_points: 0,
        traitor_points: 3
      })
    });
    const pub = await (await fetch(ctx.base + "/api/public/map")).json();
    const wall = pub.areas.find((area) => area.name === "Wall");
    assert.equal(wall.controller, "Traitor");
    assert.deepEqual(wall.tables, ["3"]);
    assert.equal(JSON.stringify(pub).includes("event_code"), false);
    assert.equal(JSON.stringify(pub).includes("display_name"), false);
  } finally {
    await ctx.stop();
  }
});
