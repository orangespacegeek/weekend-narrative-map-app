"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assignTables } = require("../lib/tables");
const { resultsFormUrl } = require("../lib/qr");

const ROOT = path.join(__dirname, "..");
const ADMIN_PW = "test-admin-pw-123";

test("tables follow the map, and a bye is left without one", () => {
  const areas = [
    { area_id: 2, name: "Spire", tables: [], scenario: "Hold the Spire" },
    { area_id: 1, name: "Wall", tables: ["1", "2"], scenario: "Breach" }
  ];
  const pairings = [
    { pairing_id: 1, round_id: 1, kind: "bye", loyalist_id: 3, traitor_id: null, table: "9", area_id: 4 },
    { pairing_id: 2, round_id: 1, kind: "normal", loyalist_id: 1, traitor_id: 4, table: null },
    { pairing_id: 3, round_id: 1, kind: "grudge", locked: true, loyalist_id: 2, traitor_id: 5, table: "2", area_id: null }
  ];
  const assigned = assignTables(pairings, areas);
  const bye = assigned.pairings.find((pairing) => pairing.kind === "bye");
  const fresh = assigned.pairings.find((pairing) => pairing.pairing_id === 2);
  const locked = assigned.pairings.find((pairing) => pairing.pairing_id === 3);
  assert.equal(bye.table, null);
  assert.equal(bye.area_id, null);
  assert.equal(locked.table, "2");
  assert.equal(locked.area_id, 1);
  assert.equal(fresh.table, "1");
  assert.equal(fresh.area_id, 1);
  assert.equal(assigned.warnings.some((line) => /booked twice|more than one/.test(line)), false);
});

test("the results QR url is the event code plus the round", () => {
  const url = resultsFormUrl("http://127.0.0.1:9", "ABCD2345", 2);
  assert.equal(url, "http://127.0.0.1:9/report.html?event=ABCD2345&round=2");
});

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wem-tables-"));
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

test("table assignment, the print sheet, and the QR stay unpublished until the organiser says so", async () => {
  const ctx = startServer();
  try {
    await ctx.ready;
    const auth = await login(ctx.base);
    const headers = auth.headers;
    const areas = await (await fetch(ctx.base + "/api/areas")).json();
    for (const area of areas) {
      const first = Number(area.area_id) === Number(areas[0].area_id);
      const second = Number(area.area_id) === Number(areas[1].area_id);
      const saved = await fetch(ctx.base + "/api/areas/" + area.area_id, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...area,
          tables: first ? ["1", "2"] : [],
          scenario: first ? "Breach" : second ? "Hold the Spire" : null
        })
      });
      assert.equal(saved.status, 200, await saved.text());
    }
    await fetch(ctx.base + "/api/players/import", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "L-01,Loyalist,Iron Hands\nL-02,Loyalist,Ultramarines\nL-03,Loyalist\nT-01,Traitor,Night Lords\nT-02,Traitor,Word Bearers"
      })
    });
    const round = await (await fetch(ctx.base + "/api/rounds", {
      method: "POST",
      headers,
      body: JSON.stringify({ number: 1 })
    })).json();
    const generated = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/pair", {
      method: "POST",
      headers,
      body: "{}"
    });
    const body = await generated.json();
    assert.equal(generated.status, 200, JSON.stringify(body));
    const games = body.pairings.filter((pairing) => pairing.kind !== "bye");
    const bye = body.pairings.find((pairing) => pairing.kind === "bye");
    assert.equal(games.length, 2);
    assert.deepEqual(games.map((pairing) => pairing.table).sort(), ["1", "2"]);
    assert.equal(bye.table, null);
    assert.equal(bye.area_id, null);
    const hiddenSheet = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/sheet");
    assert.equal(hiddenSheet.status, 404);
    const hiddenPrint = await fetch(ctx.base + "/print/round/" + round.number);
    assert.equal(hiddenPrint.status, 404);
    assert.equal((await hiddenPrint.text()).includes("event="), false);
    const hiddenQr = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/qr.svg");
    assert.equal(hiddenQr.status, 404);
    const adminQr = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/qr.svg", { headers });
    assert.equal(adminQr.status, 200);
    const event = await (await fetch(ctx.base + "/api/event", { headers })).json();
    const qrText = await adminQr.text();
    assert.match(qrText, /report\.html\?event=/);
    assert.match(qrText, new RegExp("event=" + event.event_code));
    assert.match(qrText, /round=1/);
    assert.equal(JSON.stringify(event).includes(event.event_code), true);

    const moved = games.find((pairing) => pairing.table === "2");
    const anon = await fetch(ctx.base + "/api/pairings/" + moved.pairing_id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...moved, table: "1" })
    });
    assert.equal(anon.status, 401);
    const noCsrf = await fetch(ctx.base + "/api/pairings/" + moved.pairing_id, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        Cookie: "sh_session=" + auth.cookie
      },
      body: JSON.stringify({ ...moved, table: "1" })
    });
    assert.equal(noCsrf.status, 403);
    const clash = await fetch(ctx.base + "/api/pairings/" + moved.pairing_id, {
      method: "PUT",
      headers: { ...headers, Cookie: "sh_session=" + auth.cookie },
      body: JSON.stringify({ ...moved, table: "1" })
    });
    const clashBody = await clash.json();
    assert.equal(clash.status, 200, JSON.stringify(clashBody));
    assert.ok(clashBody.warnings.some((line) => line.includes("Table 1 is assigned to more than one game")));

    const byeWrite = await fetch(ctx.base + "/api/pairings/" + bye.pairing_id, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...bye, table: "2" })
    });
    assert.equal(byeWrite.status, 400);
    assert.match((await byeWrite.json()).error, /no table/);

    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/approve", { method: "POST", headers, body: "{}" });
    await fetch(ctx.base + "/api/rounds/" + round.round_id + "/publish", { method: "POST", headers, body: "{}" });
    const sheetRes = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/sheet");
    const sheet = await sheetRes.json();
    assert.equal(sheetRes.status, 200);
    assert.equal(sheet.round.number, 1);
    assert.deepEqual(sheet.by_player.map((row) => row.display_name), ["L-01", "L-02", "L-03", "T-01", "T-02"]);
    assert.equal(sheet.by_table.every((row) => row.area === "Crossing" || row.area), true);
    assert.ok(sheet.by_table.some((row) => row.scenario === "Breach"));
    assert.ok(sheet.by_table.some((row) => row.loyalist.army === "Iron Hands" || row.traitor.army === "Night Lords"));
    assert.equal(sheet.byes.length, 1);
    assert.equal(sheet.byes[0].table, undefined);
    assert.ok(sheet.warnings.some((line) => line.includes("Table 1")));
    const dumped = JSON.stringify(sheet);
    assert.equal(dumped.includes(event.event_code), false);
    assert.equal(dumped.includes("qr_token"), false);
    assert.equal(dumped.includes("@"), false);
    const printed = await (await fetch(ctx.base + "/print/round/1")).text();
    assert.match(printed, /By table/);
    assert.match(printed, /By player/);
    assert.match(printed, /Iron Hands/);
    assert.match(printed, /L-01/);
    assert.match(printed, /Breach/);
    assert.match(printed, new RegExp("event=" + event.event_code));
    assert.equal(printed.includes("site-nav"), false);
    assert.match(printed, /@page/);
    const publicQr = await fetch(ctx.base + "/api/rounds/" + round.round_id + "/qr.svg");
    assert.equal(publicQr.status, 200);
    assert.match(publicQr.headers.get("content-type") || "", /svg/);
    const sheetPage = await fetch(ctx.base + "/print/qr-sheet");
    assert.equal(sheetPage.status, 401);
    const adminSheet = await fetch(ctx.base + "/print/qr-sheet", { headers: { Authorization: "Bearer " + auth.token } });
    assert.equal(adminSheet.status, 200);
    assert.match(await adminSheet.text(), /Round 1/);
  } finally {
    await ctx.stop();
  }
});
