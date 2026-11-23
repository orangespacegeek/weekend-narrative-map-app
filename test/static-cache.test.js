"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-cache-"));
  const port = 41000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "development",
      CAMPAIGN_ADMIN_PASSWORD: "test-admin-pw-123",
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

test("served pages version js and css, and versioned assets are immutable", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const page = await fetch(ctx.base + "/index.html");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control") || "", /no-store/);
    assert.doesNotMatch(page.headers.get("cache-control") || "", /max-age/);
    const html = await page.text();
    const script = html.match(/src="js\/api\.js\?v=([0-9a-f]{12})"/);
    const css = html.match(/href="css\/site-nav\.css\?v=([0-9a-f]{12})"/);
    assert.ok(script, html.slice(html.indexOf("js/api.js") - 20, html.indexOf("js/api.js") + 40));
    assert.ok(css);
    const expected = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "js", "api.js"))).digest("hex").slice(0, 12);
    assert.equal(script[1], expected);

    const versioned = await fetch(ctx.base + "/js/api.js?v=" + script[1]);
    assert.equal(versioned.status, 200);
    assert.match(versioned.headers.get("cache-control") || "", /immutable/);

    const bare = await fetch(ctx.base + "/js/api.js");
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get("cache-control") || "", /must-revalidate/);
    assert.match(bare.headers.get("cache-control") || "", /max-age=0/);

    const map = await fetch(ctx.base + "/campaign_map.html");
    const mapHtml = await map.text();
    assert.match(mapHtml, /src="js\/map\.js\?v=[0-9a-f]{12}"/);
    assert.match(mapHtml, /src="js\/api\.js\?v=[0-9a-f]{12}"/);
  } finally {
    await ctx.stop();
  }
});
