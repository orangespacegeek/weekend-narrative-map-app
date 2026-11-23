/**
 * Weekend Event Narrative Map.
 *
 * Static pages plus a JSON API. Campaign JSON lives in DATA_DIR.
 * Visitors can read the node-and-route map and reported results.
 * Only the event admin can sign in. There are no player accounts.
 *
 * Players report a table result from the round QR. The event code gates
 * that POST and is never written back into a response.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3847;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;

function explicitDataDir(env) {
  if (!env || env.DATA_DIR == null) return "";
  return String(env.DATA_DIR).trim();
}

function resolveDataDir(env, root) {
  const raw = explicitDataDir(env);
  return raw ? path.resolve(raw) : path.join(root, "data");
}

// Follow the nearest existing ancestor so a not-yet-created disk mount, and a
// symlink that points back into the repo, are judged by their real location.
function canonicalPath(input) {
  let current = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(input);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let real = fs.realpathSync(current);
  for (const part of suffix) real = path.join(real, part);
  return real;
}

function isInsideDir(parent, child) {
  const root = canonicalPath(parent);
  const target = canonicalPath(child);
  const rel = path.relative(root, target);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isProductionEnv(env) {
  if (!env) return false;
  if (env.NODE_ENV === "production") return true;
  return env.RENDER != null && String(env.RENDER) !== "";
}

function evaluateDataDirectory(env = process.env, root = ROOT) {
  const dataDir = resolveDataDir(env, root);
  const unset = !explicitDataDir(env);
  const production = isProductionEnv(env);
  const inside = isInsideDir(root, dataDir);
  const ephemeral = unset || inside;
  const warnings = [];
  const errors = [];
  if (production && ephemeral) {
    const where = unset
      ? "is unset and defaults to " + dataDir + ", which is inside the application directory"
      : "resolves inside the application directory (" + dataDir + ")";
    if (String(env.ALLOW_EPHEMERAL_DATA || "") === "1") {
      warnings.push("================================================================");
      warnings.push("WARNING: ALLOW_EPHEMERAL_DATA=1 — campaign data will not survive a restart or deploy.");
      warnings.push("WARNING: DATA_DIR " + where + ".");
      warnings.push(
        "WARNING: Set DATA_DIR to a persistent disk outside the code folder. On Render, mount a disk at /var/data and set DATA_DIR=/var/data."
      );
      warnings.push("WARNING: A persistent boot logs: Data directory: /var/data");
      warnings.push("================================================================");
    } else {
      errors.push("Refusing to start: DATA_DIR " + where + ".");
      errors.push(
        "Production campaign data must live on a persistent disk outside the code folder, or players, invites, and the campaign are wiped on every deploy. On Render, add a disk mounted at /var/data and set DATA_DIR=/var/data. render.yaml does that only for a service created from the Blueprint. A persistent boot logs: Data directory: /var/data"
      );
      errors.push("To start anyway, knowing the data is ephemeral, set ALLOW_EPHEMERAL_DATA=1.");
    }
  } else if (!production && unset) {
    warnings.push(
      "Warning: DATA_DIR is unset. Using " +
        dataDir +
        " inside the application directory. This is fine for local development. Set DATA_DIR to store the campaign somewhere else."
    );
  }
  return { ok: errors.length === 0, dataDir, warnings, errors, unset, inside, production, ephemeral };
}

const DATA = resolveDataDir(process.env, ROOT);
const SESSION_DAYS = 14;
// The old prototype password was published in the source repo. It is never a fallback.
const PUBLISHED_ADMIN_PASSWORD = "change-me";

const model = require("./lib/model");
const swiss = require("./lib/swiss");
const tables = require("./lib/tables");
const qr = require("./lib/qr");
const printPages = require("./lib/print");
const scoring = require("./lib/scoring");
const backup = require("./lib/backup");

// systems.json is still the seed file and the shape the current map page edits.
// map.json is the event area list (area_id, routes, tables, scenario).
const COLLECTIONS = {
  systems: { file: "systems.json", idKey: "sys_id" },
  games: { file: "games.json", idKey: "game_id" },
  meta: { file: "meta.json", idKey: null },
  accounts: { file: "accounts.json", idKey: "account_id" },
  sessions: { file: "sessions.json", idKey: "token" }
};

const DEFAULT_META = {
  event_name: "Weekend Event",
  blurb: "A one-weekend Horus Heresy narrative tournament."
};

const PUBLIC_PAGES = new Set([
  "index.html",
  "login.html",
  "campaign_map.html",
  "area-map.html",
  "map-editor.html",
  "roster.html",
  "pairings.html",
  "report.html",
  "standings.html",
  "narrative.html",
  "projector.html",
  "systems.html",
  "games.html"
]);

const PUBLIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

const GAME_RESULTS = ["in_progress", "side_a_win", "side_b_win", "draw"];
const REPORTED_BY = ["side_a", "side_b", "admin"];

function ensureDataDir() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
}

function loadBaselineSystems() {
  const fp = path.join(ROOT, "data", "baseline", "systems.json");
  if (!fs.existsSync(fp)) return [];
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  return Array.isArray(data) ? data : [];
}

function seedBaselineSystems() {
  const dest = path.join(DATA, "systems.json");
  if (fs.existsSync(dest)) return false;
  const baseline = loadBaselineSystems();
  if (!baseline.length) return false;
  ensureDataDir();
  atomicWrite(dest, JSON.stringify(baseline, null, 2) + "\n");
  console.log("Seeded " + baseline.length + " systems from data/baseline/systems.json");
  return true;
}

function seedDefaultMeta() {
  const dest = path.join(DATA, "meta.json");
  if (fs.existsSync(dest)) return false;
  ensureDataDir();
  atomicWrite(dest, JSON.stringify(DEFAULT_META, null, 2) + "\n");
  return true;
}

// The imported campaign shipped a named sample roster. This app does not.
function noteIgnoredSampleSeed() {
  if (String(process.env.SEED_SAMPLE_CAMPAIGN || "") !== "1") return;
  if (isProductionEnv(process.env)) {
    console.log("SEED_SAMPLE_CAMPAIGN=1 is ignored in production");
    return;
  }
  console.log("SEED_SAMPLE_CAMPAIGN=1 is ignored. This app does not ship a sample campaign.");
}

function atomicWrite(fp, text) {
  const tmp = fp + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, fp);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

function readCollection(name) {
  const spec = COLLECTIONS[name];
  if (!spec) return null;
  const fp = path.join(DATA, spec.file);
  if (!fs.existsSync(fp)) {
    const empty = name === "meta" ? { ...DEFAULT_META } : [];
    ensureDataDir();
    atomicWrite(fp, JSON.stringify(empty, null, 2) + "\n");
    return empty;
  }
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeCollection(name, data) {
  const spec = COLLECTIONS[name];
  if (!spec) throw new Error("Unknown collection");
  ensureDataDir();
  atomicWrite(path.join(DATA, spec.file), JSON.stringify(data, null, 2) + "\n");
}

function nextId(list, idKey) {
  if (!list.length) return 1;
  return list.reduce((m, row) => Math.max(m, Number(row[idKey]) || 0), 0) + 1;
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), s, 64).toString("hex");
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function passwordLoginRejected(account, password) {
  if (!account || !account.pass_hash || !account.pass_salt || account.needs_password === true) return true;
  return !verifyPassword(password == null ? "" : password, account.pass_salt, account.pass_hash);
}

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

function clipText(value, max) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isProduction() {
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const render = String(process.env.RENDER || "").toLowerCase();
  return nodeEnv === "production" || render === "true" || render === "1";
}

function clearAllSessions() {
  writeCollection("sessions", []);
}

function logGeneratedAdminPassword(login, password) {
  console.log("============================================================");
  console.log("CAMPAIGN_ADMIN_INITIAL_PASSWORD (printed once; not stored in plaintext)");
  console.log("login=" + login);
  console.log("password=" + password);
  console.log("Set CAMPAIGN_ADMIN_PASSWORD on the host so the next machine does not generate a different one.");
  console.log("To rotate later: set CAMPAIGN_ADMIN_PASSWORD to the new value and CAMPAIGN_ADMIN_FORCE_PASSWORD=1, restart, then remove the FORCE flag.");
  console.log("A FORCE reset also deletes every session.");
  console.log("============================================================");
}

function takeAdminPassword(login) {
  if (process.env.CAMPAIGN_ADMIN_PASSWORD) return process.env.CAMPAIGN_ADMIN_PASSWORD;
  const password = crypto.randomBytes(18).toString("base64url");
  logGeneratedAdminPassword(login, password);
  return password;
}

function bootstrapAdmin() {
  const accounts = readCollection("accounts").filter((row) => row && model.isAdminRole(row.role));
  let admin = accounts.find((row) => model.isAdminRole(row.role));
  const login = process.env.CAMPAIGN_ADMIN_LOGIN || "admin";
  const envPassword = process.env.CAMPAIGN_ADMIN_PASSWORD;
  const forceFlag = String(process.env.CAMPAIGN_ADMIN_FORCE_PASSWORD || "").toLowerCase();
  const forceFromEnv = !!envPassword && (forceFlag === "1" || forceFlag === "true" || forceFlag === "yes");

  if (!admin) {
    const password = takeAdminPassword(login);
    const { salt, hash } = hashPassword(password);
    admin = {
      account_id: nextId(accounts, "account_id"),
      role: model.CANONICAL_ADMIN_ROLE,
      label: "Event admin",
      login,
      pass_hash: hash,
      pass_salt: salt,
      provider: "local",
      created_at: new Date().toISOString().slice(0, 10)
    };
    accounts.push(admin);
    writeCollection("accounts", accounts);
    if (envPassword) console.log('Created event admin login="' + login + '" from CAMPAIGN_ADMIN_PASSWORD');
    else console.log('Created event admin login="' + login + '" with a generated password (see above)');
    return;
  }

  const previousLogin = admin.login;
  const previousRole = admin.role;
  admin.role = model.CANONICAL_ADMIN_ROLE;
  admin.login = admin.login || login;
  if (process.env.CAMPAIGN_ADMIN_LOGIN) admin.login = login;

  if (forceFromEnv) {
    const { salt, hash } = hashPassword(envPassword);
    admin.pass_hash = hash;
    admin.pass_salt = salt;
    admin.needs_password = false;
    writeCollection("accounts", accounts);
    clearAllSessions();
    console.log(
      'Applied CAMPAIGN_ADMIN_PASSWORD for login="' + admin.login + '" (FORCE env reset) and invalidated all sessions'
    );
    return;
  }

  if (!admin.pass_hash) {
    const password = takeAdminPassword(admin.login || login);
    const { salt, hash } = hashPassword(password);
    admin.pass_hash = hash;
    admin.pass_salt = salt;
    admin.needs_password = false;
    writeCollection("accounts", accounts);
    console.log('Set event admin password for login="' + admin.login + '"');
    return;
  }

  if (admin.login !== previousLogin || admin.role !== previousRole) writeCollection("accounts", accounts);

  if (isProduction() && verifyPassword(PUBLISHED_ADMIN_PASSWORD, admin.pass_salt, admin.pass_hash)) {
    console.warn(
      "Event admin still has the old published password. Login with it is disabled in production. Set CAMPAIGN_ADMIN_PASSWORD and CAMPAIGN_ADMIN_FORCE_PASSWORD=1, then restart."
    );
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function getSessionToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const cookies = parseCookies(req);
  return cookies.sh_session || null;
}

function getSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const sessions = readCollection("sessions");
  const now = Date.now();
  const live = sessions.filter((s) => s && new Date(s.expires_at).getTime() > now);
  if (live.length !== sessions.length) writeCollection("sessions", live);
  const session = live.find((s) => s.token === token);
  if (!session) return null;
  const account = readCollection("accounts").find((a) => a && a.account_id === session.account_id);
  if (!account || !model.isAdminRole(account.role)) return null;
  return { token, session, account };
}

function createSession(accountId) {
  const sessions = readCollection("sessions");
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  sessions.push({
    token,
    account_id: accountId,
    expires_at: expires.toISOString(),
    created_at: new Date().toISOString()
  });
  writeCollection("sessions", sessions);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  writeCollection("sessions", readCollection("sessions").filter((s) => s.token !== token));
}

function mePayload(account) {
  return {
    account_id: account.account_id,
    role: account.role,
    label: account.label || "Event admin",
    login: account.login || null,
    provider: account.provider || "local"
  };
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
    (req.connection && req.connection.encrypted);
  return (
    "sh_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeSeconds + (secure ? "; Secure" : "")
  );
}

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = { login: 30 };
const REPORT_CODE_MAX = 5;
const authBuckets = new Map();

function trustProxyHops() {
  const raw = String(process.env.TRUST_PROXY == null ? "" : process.env.TRUST_PROXY).trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") return 0;
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0 && n < 20) return n;
  }
  return 0;
}

function clientIp(req) {
  const hops = trustProxyHops();
  if (hops > 0) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - hops)];
    }
  }
  const sock = req.socket || req.connection;
  return (sock && sock.remoteAddress) || "unknown";
}

function rateLimitAuth(req, action) {
  const limit = AUTH_MAX_ATTEMPTS[action];
  if (!limit) return null;
  const now = Date.now();
  const key = action + "|" + clientIp(req);
  let bucket = authBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return null;
}

function reportCodeLocked(req) {
  const bucket = authBuckets.get("report_code|" + clientIp(req));
  if (!bucket || bucket.resetAt <= Date.now() || bucket.count < REPORT_CODE_MAX) return null;
  return { retryAfter: Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)) };
}

function noteBadReportCode(req) {
  const now = Date.now();
  const key = "report_code|" + clientIp(req);
  let bucket = authBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + AUTH_WINDOW_MS };
  bucket.count += 1;
  authBuckets.set(key, bucket);
}

function eventCodesMatch(given, real) {
  const left = Buffer.from(String(given == null ? "" : given));
  const right = Buffer.from(String(real == null ? "" : real));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(right, right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sendRateLimited(res, limited) {
  return send(res, 429, { error: "Too many attempts. Try again in " + limited.retryAfter + " seconds." }, {
    "Retry-After": String(limited.retryAfter)
  });
}

function configuredOrigins() {
  return String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(req, origin) {
  if (!origin) return false;
  if (configuredOrigins().includes(origin)) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host || url.host !== host) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  if (proto && url.protocol !== proto + ":") return false;
  return true;
}

function corsHeaders(req) {
  const headers = { Vary: "Origin" };
  const origin = req.headers.origin;
  if (!origin || origin === "null" || !isAllowedOrigin(req, origin)) return headers;
  headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Credentials"] = "true";
  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-SH-Request";
  return headers;
}

function send(res, status, body, extraHeaders = {}) {
  const req = res.req;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(req ? corsHeaders(req) : {}),
    ...extraHeaders
  });
  res.end(payload);
}

function assertCsrf(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  if (!parseCookies(req).sh_session) return null;
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !isAllowedOrigin(req, origin)) return "Cross-origin write blocked";
  if (req.headers["x-sh-request"] !== "1") return "Write blocked. Refresh the page and try again.";
  if (origin && origin !== "null") return null;
  const referer = req.headers.referer || req.headers.referrer || "";
  if (referer) {
    try {
      if (isAllowedOrigin(req, new URL(referer).origin)) return null;
    } catch (_) {}
  }
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return null;
  return "Write blocked. Refresh the page and try again.";
}

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 1024 * 1024;
const MAP_IMAGE_MAX_BYTES = Number(process.env.MAP_IMAGE_MAX_BYTES) || 8 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(httpError(413, "Request body too large"));
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(httpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) return;
      fail(err);
    });
  });
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(httpError(413, "Map image is too large"));
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) return;
      fail(err);
    });
  });
}

function sniffMapImage(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function mapImageDir() {
  return path.join(DATA, "maps");
}

function storedMapPath(file) {
  if (file !== "event-map.png" && file !== "event-map.jpg") return null;
  const dir = mapImageDir();
  const resolved = path.resolve(dir, file);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return null;
  return resolved;
}

function requestOrigin(req) {
  const trust = String(process.env.TRUST_PROXY || "").trim() === "1";
  const hostHeader = trust ? req.headers["x-forwarded-host"] || req.headers.host : req.headers.host;
  const host = String(hostHeader || "localhost").split(",")[0].trim();
  let proto = "http";
  if (trust && req.headers["x-forwarded-proto"]) {
    proto = String(req.headers["x-forwarded-proto"]).split(",")[0].trim() || "http";
  }
  return proto + "://" + host;
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(html);
}

function sendSvg(res, svg, downloadName) {
  const headers = {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (downloadName) headers["Content-Disposition"] = 'attachment; filename="' + downloadName + '"';
  res.writeHead(200, headers);
  res.end(svg);
}

function bindTable(pairing, areas) {
  if (pairing.kind === "bye") {
    if (pairing.table) return { ok: false, error: "A bye has no table" };
    pairing.table = null;
    pairing.area_id = null;
    return { ok: true, pairing };
  }
  if (!pairing.table) return { ok: true, pairing };
  const slot = tables.tableSlots(areas).slots.find((item) => item.table === pairing.table);
  if (slot) pairing.area_id = slot.area_id;
  return { ok: true, pairing };
}

function roundPairings(roundId) {
  return readList("pairings.json").filter((pairing) => Number(pairing.round_id) === Number(roundId));
}

function roundIsPublic(rows) {
  return rows.length > 0 && rows.every((pairing) => pairing.state === "published");
}

function requireAdmin(req) {
  const auth = getSession(req);
  if (!auth) return { ok: false, status: 401, error: "Login required" };
  if (!model.isAdminRole(auth.account.role)) return { ok: false, status: 403, error: "Admin only" };
  return { ok: true, auth };
}

function publicMeta(meta) {
  const src = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  return {
    event_name: clipText(src.event_name, 80) || DEFAULT_META.event_name,
    blurb: clipText(src.blurb, 280) || DEFAULT_META.blurb
  };
}

function publicCounts() {
  const results = readList("results.json");
  return {
    nodes: Array.isArray(readCollection("systems")) ? readCollection("systems").length : 0,
    results: results.filter((result) => result && result.confirmation === "confirmed").length,
    pending: results.filter((result) => result && (result.confirmation === "pending" || result.confirmation === "disputed")).length
  };
}

const assetVersions = new Map();

function assetVersion(absPath) {
  const st = fs.statSync(absPath);
  const key = absPath + "\0" + st.mtimeMs + "\0" + st.size;
  const cached = assetVersions.get(key);
  if (cached) return cached;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex").slice(0, 12);
  assetVersions.set(key, hash);
  return hash;
}

function versionAssetUrls(html) {
  const rootResolved = path.resolve(ROOT);
  return html.replace(/\b(src|href)="([^"]+)"/g, (full, attr, url) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return full;
    const pathOnly = url.split("#")[0].split("?")[0];
    if (!/\.(?:js|css)$/i.test(pathOnly)) return full;
    if (pathOnly.split("/").some((part) => !part || part === "." || part === "..")) return full;
    if (/[?&]v=/.test(url)) return full;
    const abs = path.resolve(rootResolved, pathOnly);
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return full;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return full;
    return attr + '="' + url + (url.includes("?") ? "&" : "?") + "v=" + assetVersion(abs) + '"';
  });
}

function staticCacheControl(req, ext) {
  if (ext !== ".js" && ext !== ".css") return "public, max-age=3600";
  let versioned = false;
  try {
    versioned = new URL(req.url || "/", "http://localhost").searchParams.has("v");
  } catch (_) {}
  if (versioned) return "public, max-age=31536000, immutable";
  return "public, max-age=0, must-revalidate";
}

function isPublicAsset(parts) {
  if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("."))) return false;
  if (parts.length === 1) {
    const name = parts[0];
    if (PUBLIC_PAGES.has(name)) return true;
    const ext = path.extname(name).toLowerCase();
    return ext !== ".html" && ext !== ".js" && ext !== ".css" && !!PUBLIC_TYPES[ext];
  }
  if (parts.length === 2 && parts[0] === "js" && path.extname(parts[1]).toLowerCase() === ".js") return true;
  if (parts.length === 2 && parts[0] === "css" && path.extname(parts[1]).toLowerCase() === ".css") return true;
  return false;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : String(pathname || "/");
  rel = path.posix.normalize(rel);
  if (!rel.startsWith("/") || rel.includes("\0")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const parts = rel.split("/").filter(Boolean);
  if (!isPublicAsset(parts)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const rootResolved = path.resolve(ROOT);
  const fp = path.resolve(rootResolved, ...parts);
  if (fp !== rootResolved && !fp.startsWith(rootResolved + path.sep)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  const type = PUBLIC_TYPES[ext] || "application/octet-stream";
  if (ext === ".html") {
    const theme = siteTheme();
    const html = versionAssetUrls(fs.readFileSync(fp, "utf8")).replace('data-site-theme=""', 'data-site-theme="' + theme + '"');
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": staticCacheControl(req, ext),
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(fp).pipe(res);
}

async function handleAuth(req, res, parts, method) {
  const action = parts[1];
  if (method === "OPTIONS") return send(res, 204, "");

  if (action === "signup" || action === "invites" || action === "create-invite" || action === "password-resets") {
    return send(res, 404, {
      error: "This event has no player accounts. Players do not sign up or sign in."
    });
  }

  if (action === "me" && method === "GET") {
    const auth = getSession(req);
    if (!auth) return send(res, 200, { authenticated: false, role: "visitor" });
    return send(res, 200, { authenticated: true, ...mePayload(auth.account) });
  }

  if (action === "logout" && method === "POST") {
    destroySession(getSessionToken(req));
    return send(res, 200, { ok: true }, {
      "Set-Cookie": "sh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    });
  }

  if (action === "login" && method === "POST") {
    const limited = rateLimitAuth(req, "login");
    if (limited) return sendRateLimited(res, limited);
    const body = (await readBody(req)) || {};
    if (body.invite_code) {
      return send(res, 404, { error: "This event has no player accounts. Players do not sign up or sign in." });
    }
    if (isProduction() && String(body.password || "") === PUBLISHED_ADMIN_PASSWORD) {
      return send(res, 401, {
        error: "That password is no longer accepted. Set CAMPAIGN_ADMIN_PASSWORD and CAMPAIGN_ADMIN_FORCE_PASSWORD=1 on the host, then restart."
      });
    }
    if (!body.login) return send(res, 400, { error: "Provide login and password" });
    const accounts = readCollection("accounts");
    const account = accounts.find(
      (a) => a && String(a.login || "").toLowerCase() === String(body.login).trim().toLowerCase()
    );
    if (!account || !model.isAdminRole(account.role) || passwordLoginRejected(account, body.password)) {
      return send(res, 401, { error: "Invalid login or password" });
    }
    if (account.role !== model.CANONICAL_ADMIN_ROLE) {
      account.role = model.CANONICAL_ADMIN_ROLE;
      writeCollection("accounts", accounts);
    }
    const { token, expires } = createSession(account.account_id);
    return send(res, 200, { ok: true, token, expires_at: expires.toISOString(), ...mePayload(account) }, {
      "Set-Cookie": sessionCookie(req, token, SESSION_DAYS * 86400)
    });
  }

  if (action === "set-password" && method === "POST") {
    const gate = requireAdmin(req);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const password = String(body.password || "");
    if (password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters" });
    if (password.length > 128) return send(res, 400, { error: "Password must be at most 128 characters" });
    if (isProduction() && password === PUBLISHED_ADMIN_PASSWORD) {
      return send(res, 400, { error: "Choose a different password" });
    }
    const accounts = readCollection("accounts");
    const idx = accounts.findIndex((a) => a.account_id === gate.auth.account.account_id);
    if (idx < 0) return send(res, 404, { error: "Account not found" });
    const row = accounts[idx];
    if (row.pass_hash) {
      if (!body.current_password) return send(res, 400, { error: "Current password required" });
      if (!verifyPassword(body.current_password, row.pass_salt, row.pass_hash)) {
        return send(res, 401, { error: "Current password is wrong" });
      }
    }
    const { salt, hash } = hashPassword(password);
    accounts[idx].pass_hash = hash;
    accounts[idx].pass_salt = salt;
    accounts[idx].needs_password = false;
    writeCollection("accounts", accounts);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Unknown auth route" });
}

function normalizeLinks(raw) {
  let ids = [];
  if (Array.isArray(raw)) ids = raw.map((n) => Number(n));
  else if (raw == null || raw === "") ids = [];
  else {
    ids = String(raw)
      .split(",")
      .map((s) => Number(String(s).trim()));
  }
  const clean = [];
  ids.forEach((n) => {
    if (!Number.isInteger(n) || n < 1 || clean.includes(n)) return;
    clean.push(n);
  });
  return clean;
}

function readCoord(value, fallback, max) {
  if (value == null || value === "") return { ok: true, value: fallback };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false };
  const clamped = Math.round(Math.min(max, Math.max(0, n)) * 10) / 10;
  return { ok: true, value: clamped };
}

function cleanNode(body, existing) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Expected a node object" };
  }
  const name = clipText(body.sys_name, 80);
  if (!name) return { error: "Node name is required" };
  const x = readCoord(body.sys_x, existing && existing.sys_x != null ? Number(existing.sys_x) : 400, 800);
  const y = readCoord(body.sys_y, existing && existing.sys_y != null ? Number(existing.sys_y) : 280, 560);
  if (!x.ok || !y.ok) return { error: "Position must be a number" };
  const notes = clipText(body.sys_notes, 500);
  const links = normalizeLinks(body.sys_links).filter((id) => !existing || id !== Number(existing.sys_id));
  return {
    value: {
      sys_name: name,
      sys_x: x.value,
      sys_y: y.value,
      sys_links: links.join(","),
      sys_notes: notes
    },
    links
  };
}

function knownNodeIds(list, extraId) {
  const ids = new Set(list.map((row) => Number(row.sys_id)));
  if (extraId) ids.add(Number(extraId));
  return ids;
}

function linksExist(links, ids) {
  return links.every((id) => ids.has(id));
}

function stripLink(list, removedId) {
  const id = Number(removedId);
  return list.map((row) => {
    const links = normalizeLinks(row.sys_links).filter((n) => n !== id);
    return { ...row, sys_links: links.join(",") };
  });
}

function parseVictoryPoints(value) {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value === "boolean") return { ok: false };
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) return { ok: false };
    return { ok: true, value };
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n)) return { ok: true, value: n };
  }
  return { ok: false };
}

function isDecisive(result) {
  return result === "side_a_win" || result === "side_b_win" || result === "draw";
}

function cleanGame(body, existing) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Expected a result object" };
  const sideA = clipText(body.side_a, 80);
  const sideB = clipText(body.side_b, 80);
  if (!sideA || !sideB) return { error: "Both sides need a label" };
  if (sideA.toLowerCase() === sideB.toLowerCase()) return { error: "The two sides must be different" };
  const sysId = Number(body.sys_id);
  if (!Number.isInteger(sysId) || sysId < 1) return { error: "Pick a node on the map" };
  const systems = readCollection("systems");
  if (!systems.some((s) => Number(s.sys_id) === sysId)) return { error: "Node not found" };
  const result = body.result || "in_progress";
  if (!GAME_RESULTS.includes(result)) return { error: "Result is not valid" };
  const vpA = parseVictoryPoints(body.side_a_vp);
  const vpB = parseVictoryPoints(body.side_b_vp);
  if (!vpA.ok || !vpB.ok) return { error: "Victory points must be a non-negative integer" };
  let played = null;
  if (body.played_on != null && body.played_on !== "") {
    played = String(body.played_on).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(played)) return { error: "Date must be YYYY-MM-DD" };
  }
  let reportedBy = null;
  if (isDecisive(result)) {
    reportedBy = body.reported_by || (existing && existing.reported_by) || "admin";
    if (!REPORTED_BY.includes(reportedBy)) return { error: "Say who reported the result" };
  }
  const game = {
    game_id: existing ? existing.game_id : null,
    sys_id: sysId,
    played_on: played,
    mission: clipText(body.mission, 80),
    side_a: sideA,
    side_b: sideB,
    side_a_vp: vpA.value,
    side_b_vp: vpB.value,
    result,
    result_state: isDecisive(result) ? "pending" : "open",
    reported_by: reportedBy,
    confirmed_by: null,
    confirmed_at: null,
    dispute_note: null,
    disputed_at: null,
    notes: clipText(body.notes, 500),
    updated_at: new Date().toISOString()
  };
  if (!existing) game.created_at = game.updated_at;
  else game.created_at = existing.created_at || game.updated_at;
  return { value: game };
}

function publicGame(game) {
  if (!game || typeof game !== "object") return game;
  return {
    game_id: game.game_id,
    sys_id: game.sys_id,
    played_on: game.played_on || null,
    mission: game.mission || "",
    side_a: game.side_a || "",
    side_b: game.side_b || "",
    side_a_vp: game.side_a_vp == null ? null : game.side_a_vp,
    side_b_vp: game.side_b_vp == null ? null : game.side_b_vp,
    result: game.result || "in_progress",
    result_state: game.result_state || "open",
    reported_by: game.reported_by || null,
    confirmed_by: game.confirmed_by || null,
    confirmed_at: game.confirmed_at || null,
    dispute_note: game.dispute_note || null,
    disputed_at: game.disputed_at || null,
    notes: game.notes || ""
  };
}

async function confirmResult(req, res, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const as = body.as === "opponent" ? "opponent" : "admin";
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const game = { ...list[idx] };
  const pending = game.result_state === "pending";
  const disputed = game.result_state === "disputed";
  if (!isDecisive(game.result) || (!pending && !(disputed && as === "admin"))) {
    return send(res, 409, { error: "This result is not waiting for confirmation" });
  }
  if (as === "opponent") {
    if (!pending) return send(res, 409, { error: "A disputed result is resolved by the admin" });
    if (game.reported_by !== "side_a" && game.reported_by !== "side_b") {
      return send(res, 409, {
        error: "Opponent confirmation needs a result reported by one side. Phone reporting is a later update."
      });
    }
  }
  game.result_state = "confirmed";
  game.confirmed_by = as;
  game.confirmed_at = new Date().toISOString();
  game.updated_at = game.confirmed_at;
  list[idx] = game;
  writeCollection("games", list);
  return send(res, 200, publicGame(game));
}

async function disputeResult(req, res, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const note = clipText(body.note, 300);
  if (String(body.note || "").trim().length > 300) {
    return send(res, 400, { error: "Dispute note must be at most 300 characters" });
  }
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const game = { ...list[idx] };
  if (game.result_state !== "pending") {
    return send(res, 409, { error: "Only a result waiting for confirmation can be disputed" });
  }
  game.result_state = "disputed";
  game.dispute_note = note || null;
  game.disputed_at = new Date().toISOString();
  game.confirmed_by = null;
  game.confirmed_at = null;
  game.updated_at = game.disputed_at;
  list[idx] = game;
  writeCollection("games", list);
  return send(res, 200, publicGame(game));
}

async function voidResult(req, res, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("games");
  const idx = list.findIndex((g) => String(g.game_id) === String(idPart));
  if (idx < 0) return send(res, 404, { error: "Not found" });
  const game = { ...list[idx] };
  if (!["pending", "confirmed", "disputed"].includes(game.result_state)) {
    return send(res, 409, { error: "This result is not waiting to be cleared" });
  }
  game.result = "in_progress";
  game.result_state = "open";
  game.reported_by = null;
  game.confirmed_by = null;
  game.confirmed_at = null;
  game.dispute_note = null;
  game.disputed_at = null;
  game.side_a_vp = null;
  game.side_b_vp = null;
  game.updated_at = new Date().toISOString();
  list[idx] = game;
  writeCollection("games", list);
  return send(res, 200, publicGame(game));
}

function readJsonFile(name, fallback) {
  const fp = path.join(DATA, name);
  if (!fs.existsSync(fp)) return fallback;
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function writeJsonFile(name, data) {
  ensureDataDir();
  atomicWrite(path.join(DATA, name), JSON.stringify(data, null, 2) + "\n");
}

function readMapFile() {
  const map = readJsonFile("map.json", null);
  if (!map || typeof map !== "object" || !Array.isArray(map.areas)) return { image: null, areas: [] };
  return { image: map.image || null, areas: map.areas };
}

function writeMapFile(map) {
  writeJsonFile("map.json", { image: map.image || null, areas: map.areas || [] });
}

function syncMapFromSystems(systems) {
  const map = readMapFile();
  const previous = new Map(map.areas.map((area) => [Number(area.area_id), area]));
  const areas = systems.map((sys) => model.mergeSystemEdit(previous.get(Number(sys.sys_id)), model.areaFromSystem(sys)));
  writeMapFile({ image: map.image, areas });
}

function persistSystems(list) {
  writeCollection("systems", list);
  syncMapFromSystems(list);
}

function syncSystemsFromAreas(areas) {
  writeCollection("systems", areas.map(model.systemFromArea));
}

function readList(name) {
  const data = readJsonFile(name, []);
  return Array.isArray(data) ? data : [];
}

function migrateImportedMap() {
  if (fs.existsSync(path.join(DATA, "map.json"))) return false;
  const systemsPath = path.join(DATA, "systems.json");
  if (!fs.existsSync(systemsPath)) return false;
  const systems = JSON.parse(fs.readFileSync(systemsPath, "utf8"));
  if (!Array.isArray(systems) || !systems.length) return false;
  writeMapFile({ image: null, areas: systems.map(model.areaFromSystem) });
  console.log("Migrated " + systems.length + " areas from systems.json");
  return true;
}

function ensureEvent() {
  const existing = readJsonFile("event.json", null);
  const meta = readJsonFile("meta.json", null);
  if (!existing) {
    const event = model.defaultEvent({
      name: meta && meta.event_name,
      blurb: meta && meta.blurb
    });
    writeJsonFile("event.json", event);
    return event;
  }
  const checked = model.validateEvent(existing, existing);
  const event = checked.ok ? checked.value : model.defaultEvent(existing);
  if (!existing.event_code) event.event_code = model.generateEventCode();
  else event.event_code = existing.event_code;
  if (JSON.stringify(event) !== JSON.stringify(existing)) writeJsonFile("event.json", event);
  return event;
}

function eventContext() {
  return {
    event: readJsonFile("event.json", model.defaultEvent()),
    areas: readMapFile().areas,
    players: readList("players.json"),
    rounds: readList("rounds.json"),
    pairings: readList("pairings.json"),
    results: readList("results.json")
  };
}

function duplicateName(players, name, exceptId) {
  const key = String(name || "").toLowerCase();
  return players.some(
    (player) => Number(player.player_id) !== Number(exceptId) && String(player.display_name || "").toLowerCase() === key
  );
}

async function handleSystemsWrite(req, res, method, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("systems");

  if (method === "DELETE") {
    const idx = list.findIndex((row) => String(row.sys_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const removed = list[idx].sys_id;
    const next = stripLink(list.filter((_, i) => i !== idx), removed);
    persistSystems(next);
    return send(res, 200, { ok: true, deleted: removed });
  }

  const body = (await readBody(req)) || {};
  if (method === "POST" && idPart == null) {
    const cleaned = cleanNode(body, null);
    if (cleaned.error) return send(res, 400, { error: cleaned.error });
    const id = nextId(list, "sys_id");
    if (!linksExist(cleaned.links, knownNodeIds(list))) {
      return send(res, 400, { error: "A route points at a node that is not on the map" });
    }
    const row = { sys_id: id, ...cleaned.value, sys_links: cleaned.links.filter((n) => n !== id).join(",") };
    list.push(row);
    persistSystems(list);
    return send(res, 201, row);
  }

  if (method === "PUT" && idPart != null) {
    const idx = list.findIndex((row) => String(row.sys_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const cleaned = cleanNode(body, list[idx]);
    if (cleaned.error) return send(res, 400, { error: cleaned.error });
    const id = Number(list[idx].sys_id);
    const links = cleaned.links.filter((n) => n !== id);
    if (!linksExist(links, knownNodeIds(list))) {
      return send(res, 400, { error: "A route points at a node that is not on the map" });
    }
    const row = { sys_id: id, ...cleaned.value, sys_links: links.join(",") };
    list[idx] = row;
    persistSystems(list);
    return send(res, 200, row);
  }

  return send(res, 405, { error: "Method not allowed" });
}

async function handleGamesWrite(req, res, method, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readCollection("games");

  if (method === "DELETE") {
    const idx = list.findIndex((row) => String(row.game_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const removed = list[idx].game_id;
    writeCollection("games", list.filter((_, i) => i !== idx));
    return send(res, 200, { ok: true, deleted: removed });
  }

  const body = (await readBody(req)) || {};
  if (method === "POST" && idPart == null) {
    const cleaned = cleanGame(body, null);
    if (cleaned.error) return send(res, 400, { error: cleaned.error });
    cleaned.value.game_id = nextId(list, "game_id");
    list.push(cleaned.value);
    writeCollection("games", list);
    return send(res, 201, publicGame(cleaned.value));
  }

  if (method === "PUT" && idPart != null) {
    const idx = list.findIndex((row) => String(row.game_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const cleaned = cleanGame(body, list[idx]);
    if (cleaned.error) return send(res, 400, { error: cleaned.error });
    list[idx] = cleaned.value;
    writeCollection("games", list);
    return send(res, 200, publicGame(cleaned.value));
  }

  return send(res, 405, { error: "Method not allowed" });
}

async function handleMetaWrite(req, res) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const next = publicMeta({
    event_name: body.event_name,
    blurb: body.blurb
  });
  if (!clipText(body.event_name, 80)) return send(res, 400, { error: "Event name is required" });
  writeCollection("meta", next);
  return send(res, 200, next);
}

async function handleEvent(req, res, method) {
  if (method === "GET") {
    const event = readJsonFile("event.json", null) || ensureEvent();
    const gate = requireAdmin(req);
    return send(res, 200, gate.ok ? event : model.publicEvent(event));
  }
  if (method === "PUT") {
    const gate = requireAdmin(req);
    if (!gate.ok) return send(res, gate.status, { error: gate.error });
    const body = (await readBody(req)) || {};
    const existing = readJsonFile("event.json", null) || ensureEvent();
    const checked = model.validateEvent(body, existing);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    checked.value.event_code = existing.event_code;
    writeJsonFile("event.json", checked.value);
    writeJsonFile("meta.json", { event_name: checked.value.name, blurb: checked.value.blurb });
    return send(res, 200, checked.value);
  }
  return send(res, 405, { error: "Method not allowed" });
}

function scoringInput() {
  const event = readJsonFile("event.json", null) || ensureEvent();
  return {
    players: readList("players.json"),
    pairings: readList("pairings.json"),
    results: readList("results.json"),
    rounds: readList("rounds.json"),
    areas: readMapFile().areas,
    roundsPlanned: event.rounds_planned,
    blurbs: readList("narrative.json")
  };
}

function presentMap(map) {
  const control = scoring.scoreState(scoringInput()).control;
  const rounds = readList("rounds.json");
  const image = map.image ? { ...map.image, url: "/api/map/image" } : null;
  return {
    image,
    areas: (map.areas || []).map((area) => ({
      ...area,
      controller: model.currentAreaController(area.area_id, control, rounds)
    }))
  };
}

async function handleMapImage(req, res, method) {
  if (method === "GET") return send(res, 200, presentMap(readMapFile()));
  if (method !== "PUT") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const map = readMapFile();
  if (Object.prototype.hasOwnProperty.call(body, "image")) {
    const image = model.validateImage(body.image);
    if (!image.ok) return send(res, 400, { error: image.error });
    map.image = image.value;
  }
  if (Object.prototype.hasOwnProperty.call(body, "areas")) {
    const areas = model.validateAreaSet(body.areas);
    if (!areas.ok) return send(res, 400, { error: areas.error });
    map.areas = areas.value;
    syncSystemsFromAreas(map.areas);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "image") && !Object.prototype.hasOwnProperty.call(body, "areas")) {
    return send(res, 400, { error: "Send an image reference, a list of areas, or both" });
  }
  writeMapFile(map);
  return send(res, 200, presentMap(map));
}

async function handleMapUpload(req, res, method) {
  if (method === "GET") {
    const map = readMapFile();
    const file = map.image && map.image.file;
    const fp = storedMapPath(file);
    if (!fp || !fs.existsSync(fp)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("No map image");
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": ext === ".png" ? "image/png" : "image/jpeg",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const buf = await readRawBody(req, MAP_IMAGE_MAX_BYTES);
  const kind = sniffMapImage(buf);
  if (!kind) return send(res, 400, { error: "Upload a PNG or JPEG map image" });
  const size = kind === "png" ? pngSize(buf) : jpegSize(buf);
  if (!size || !size.width || !size.height) return send(res, 400, { error: "Could not read the image size" });
  const filename = kind === "png" ? "event-map.png" : "event-map.jpg";
  const dir = mapImageDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = storedMapPath(filename);
  fs.writeFileSync(dest, buf);
  const other = storedMapPath(kind === "png" ? "event-map.jpg" : "event-map.png");
  if (other && fs.existsSync(other)) fs.unlinkSync(other);
  const map = readMapFile();
  map.image = { file: filename, width: size.width, height: size.height };
  writeMapFile(map);
  return send(res, 201, presentMap(map));
}

async function handleAreas(req, res, method, idPart) {
  const map = readMapFile();
  if (method === "GET") {
    if (idPart == null) return send(res, 200, map.areas);
    const area = map.areas.find((row) => String(row.area_id) === String(idPart));
    if (!area) return send(res, 404, { error: "Not found" });
    return send(res, 200, area);
  }
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method === "DELETE") {
    const idx = map.areas.findIndex((row) => String(row.area_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const removed = Number(map.areas[idx].area_id);
    if (readList("pairings.json").some((pairing) => Number(pairing.area_id) === removed)) {
      return send(res, 409, { error: "An area used by a pairing cannot be deleted" });
    }
    const areas = map.areas
      .filter((row) => Number(row.area_id) !== removed)
      .map((row) => ({ ...row, routes: (row.routes || []).filter((id) => Number(id) !== removed) }));
    writeMapFile({ image: map.image, areas });
    syncSystemsFromAreas(areas);
    return send(res, 200, { ok: true, deleted: removed });
  }
  const body = (await readBody(req)) || {};
  const known = new Set(map.areas.map((row) => Number(row.area_id)));
  if (method === "POST" && idPart == null) {
    const checked = model.validateArea(body, null, known);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    checked.value.area_id = nextId(map.areas, "area_id");
    checked.value.routes = checked.value.routes.filter((id) => id !== checked.value.area_id);
    map.areas.push(checked.value);
    writeMapFile(map);
    syncSystemsFromAreas(map.areas);
    return send(res, 201, checked.value);
  }
  if (method === "PUT" && idPart != null) {
    const idx = map.areas.findIndex((row) => String(row.area_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const checked = model.validateArea(body, map.areas[idx], known);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    checked.value.area_id = map.areas[idx].area_id;
    map.areas[idx] = checked.value;
    writeMapFile(map);
    syncSystemsFromAreas(map.areas);
    return send(res, 200, checked.value);
  }
  return send(res, 405, { error: "Method not allowed" });
}

async function handlePlayers(req, res, method, idPart) {
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const list = readList("players.json");
  if (method === "GET") {
    if (idPart == null) return send(res, 200, list);
    const row = list.find((player) => String(player.player_id) === String(idPart));
    if (!row) return send(res, 404, { error: "Not found" });
    return send(res, 200, row);
  }
  if (method === "DELETE") {
    const id = Number(idPart);
    if (!list.some((player) => Number(player.player_id) === id)) return send(res, 404, { error: "Not found" });
    const used = readList("pairings.json").some(
      (pairing) => Number(pairing.loyalist_id) === id || Number(pairing.traitor_id) === id
    );
    if (used) return send(res, 409, { error: "An entrant who is already paired cannot be deleted" });
    writeJsonFile("players.json", list.filter((player) => Number(player.player_id) !== id));
    return send(res, 200, { ok: true, deleted: id });
  }
  const body = (await readBody(req)) || {};
  if (method === "POST" && idPart === "import") {
    const parsed = model.parseRosterImport(body.text);
    if (!parsed.ok) return send(res, 400, { error: parsed.error });
    for (const row of parsed.value) {
      if (duplicateName(list, row.display_name)) {
        return send(res, 409, { error: row.display_name + " is already on the roster" });
      }
    }
    parsed.value.forEach((row) => {
      row.player_id = nextId(list, "player_id");
      list.push(row);
    });
    writeJsonFile("players.json", list);
    return send(res, 201, { added: parsed.value.map(model.publicEntrant) });
  }
  if (method === "POST" && idPart == null) {
    const checked = model.validatePlayer(body, null);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    if (duplicateName(list, checked.value.display_name)) return send(res, 409, { error: "That display name is already in use" });
    checked.value.player_id = nextId(list, "player_id");
    list.push(checked.value);
    writeJsonFile("players.json", list);
    return send(res, 201, checked.value);
  }
  if (method === "PUT" && idPart != null) {
    const idx = list.findIndex((player) => String(player.player_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const checked = model.validatePlayer(body, list[idx]);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    if (duplicateName(list, checked.value.display_name, list[idx].player_id)) {
      return send(res, 409, { error: "That display name is already in use" });
    }
    checked.value.player_id = list[idx].player_id;
    list[idx] = checked.value;
    writeJsonFile("players.json", list);
    return send(res, 200, checked.value);
  }
  return send(res, 405, { error: "Method not allowed" });
}

async function handleRounds(req, res, method, idPart) {
  const list = readList("rounds.json");
  if (method === "GET") {
    const gate = requireAdmin(req);
    const rows = gate.ok ? list : list.map(model.publicRound);
    if (idPart == null) return send(res, 200, rows);
    const row = rows.find((round) => String(round.round_id) === String(idPart));
    if (!row) return send(res, 404, { error: "Not found" });
    return send(res, 200, row);
  }
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method === "DELETE") {
    const id = Number(idPart);
    if (!list.some((round) => Number(round.round_id) === id)) return send(res, 404, { error: "Not found" });
    if (readList("pairings.json").some((pairing) => Number(pairing.round_id) === id)) {
      return send(res, 409, { error: "A round that already has pairings cannot be deleted" });
    }
    writeJsonFile("rounds.json", list.filter((round) => Number(round.round_id) !== id));
    return send(res, 200, { ok: true, deleted: id });
  }
  const body = (await readBody(req)) || {};
  const event = readJsonFile("event.json", null) || ensureEvent();
  if (method === "POST" && idPart == null) {
    const checked = model.validateRound(body, null, event);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    if (list.some((round) => Number(round.number) === checked.value.number)) {
      return send(res, 409, { error: "That round already exists" });
    }
    checked.value.round_id = nextId(list, "round_id");
    list.push(checked.value);
    writeJsonFile("rounds.json", list);
    return send(res, 201, checked.value);
  }
  if (method === "PUT" && idPart != null) {
    const idx = list.findIndex((round) => String(round.round_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const checked = model.validateRound(body, list[idx], event);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    if (list.some((round, i) => i !== idx && Number(round.number) === checked.value.number)) {
      return send(res, 409, { error: "That round already exists" });
    }
    checked.value.round_id = list[idx].round_id;
    checked.value.qr_token = list[idx].qr_token;
    list[idx] = checked.value;
    writeJsonFile("rounds.json", list);
    return send(res, 200, checked.value);
  }
  return send(res, 405, { error: "Method not allowed" });
}

function byeResult(pairing) {
  const loyal = !!pairing.loyalist_id;
  return {
    pairing_id: pairing.pairing_id,
    round_id: pairing.round_id,
    loyalist_vp: loyal ? model.SCORING.bye_vp : null,
    traitor_vp: loyal ? null : model.SCORING.bye_vp,
    outcome: "bye",
    confirmation: "confirmed",
    reported_by: "admin",
    confirmed_by: "admin",
    campaign_points: loyal ? { loyalist: model.SCORING.win, traitor: 0 } : { loyalist: 0, traitor: model.SCORING.win }
  };
}

async function handleGenerateRound(req, res, method, idPart) {
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const roundId = Number(idPart);
  const rounds = readList("rounds.json");
  if (!rounds.some((round) => Number(round.round_id) === roundId)) return send(res, 404, { error: "Round not found" });
  let pairings = readList("pairings.json");
  const mine = pairings.filter((pairing) => Number(pairing.round_id) === roundId);
  if (mine.some((pairing) => pairing.state === "published")) {
    return send(res, 409, { error: "Published pairings stay. Clear them before generating again." });
  }
  const removed = new Set(
    mine.filter((pairing) => pairing.kind !== "apex" && pairing.kind !== "grudge").map((pairing) => Number(pairing.pairing_id))
  );
  pairings = pairings.filter((pairing) => !removed.has(Number(pairing.pairing_id)));
  const results = readList("results.json").filter((result) => !removed.has(Number(result.pairing_id)));
  const generated = swiss.generateSwiss({
    players: readList("players.json"),
    pairings,
    results,
    roundId,
    seed: body.seed
  });
  if (!generated.ok) return send(res, 409, { error: generated.error, warnings: generated.warnings || [] });
  if (generated.createdPlayers && generated.createdPlayers.length) {
    const players = readList("players.json");
    generated.createdPlayers.forEach((player) => {
      players.push({
        player_id: player.player_id,
        display_name: player.display_name,
        faction: player.faction,
        army: null,
        dropped: false,
        bye: false,
        is_stand_in: true
      });
    });
    writeJsonFile("players.json", players);
  }
  const made = [];
  generated.byes.forEach((player) => {
    const pairing = {
      pairing_id: nextId(pairings, "pairing_id"),
      round_id: roundId,
      table: null,
      area_id: null,
      kind: "bye",
      locked: false,
      state: "draft",
      loyalist_id: player.faction === "Loyalist" ? player.player_id : null,
      traitor_id: player.faction === "Traitor" ? player.player_id : null
    };
    pairings.push(pairing);
    made.push(pairing);
  });
  generated.pairs.forEach(([loyalist, traitor]) => {
    const pairing = {
      pairing_id: nextId(pairings, "pairing_id"),
      round_id: roundId,
      table: null,
      area_id: null,
      kind: "normal",
      locked: false,
      state: "draft",
      loyalist_id: loyalist.player_id,
      traitor_id: traitor.player_id
    };
    pairings.push(pairing);
    made.push(pairing);
  });
  const madeIds = new Set(made.map((pairing) => Number(pairing.pairing_id)));
  const assigned = tables.assignTables(
    pairings.filter((pairing) => Number(pairing.round_id) === roundId),
    readMapFile().areas
  );
  const assignedById = new Map(assigned.pairings.map((pairing) => [Number(pairing.pairing_id), pairing]));
  pairings = pairings.map((pairing) => assignedById.get(Number(pairing.pairing_id)) || pairing);
  writeJsonFile("pairings.json", pairings);
  writeJsonFile("results.json", results);
  return send(res, 200, {
    pairings: pairings.filter((pairing) => madeIds.has(Number(pairing.pairing_id))),
    warnings: (generated.warnings || []).concat(assigned.warnings),
    standings: generated.standings
  });
}

async function handleRoundState(req, res, method, idPart, target) {
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const roundId = Number(idPart);
  const pairings = readList("pairings.json");
  const mine = pairings.filter((pairing) => Number(pairing.round_id) === roundId);
  if (!mine.length) return send(res, 404, { error: "This round has no pairings" });
  if (target === "published" && mine.some((pairing) => pairing.state === "draft")) {
    return send(res, 409, { error: "Approve the draft before publishing" });
  }
  mine.forEach((pairing) => {
    if (target === "approved" && pairing.state === "draft") pairing.state = "approved";
    if (target === "published" && pairing.state === "approved") pairing.state = "published";
  });
  writeJsonFile("pairings.json", pairings);
  if (target === "published") {
    const results = readList("results.json");
    mine.forEach((pairing) => {
      if (pairing.kind !== "bye" || pairing.state !== "published") return;
      if (results.some((result) => Number(result.pairing_id) === Number(pairing.pairing_id))) return;
      const result = byeResult(pairing);
      result.result_id = nextId(results, "result_id");
      results.push(result);
    });
    writeJsonFile("results.json", results);
  }
  return send(res, 200, { pairings: mine });
}

function sheetFor(round) {
  const event = readJsonFile("event.json", null) || ensureEvent();
  return tables.buildSheet({
    eventName: event.name,
    round,
    pairings: roundPairings(round.round_id),
    players: readList("players.json"),
    areas: readMapFile().areas
  });
}

function roundQr(req, round) {
  const event = readJsonFile("event.json", null) || ensureEvent();
  const target = qr.resultsFormUrl(requestOrigin(req), event.event_code, round.number);
  return { target, svg: qr.qrSvg(target) };
}

async function handleRoundSheet(req, res, method, idPart) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const round = readList("rounds.json").find((row) => String(row.round_id) === String(idPart));
  if (!round) return send(res, 404, { error: "Round not found" });
  if (!roundIsPublic(roundPairings(round.round_id))) return send(res, 404, { error: "Pairings are not published yet" });
  return send(res, 200, sheetFor(round));
}

async function handleRoundQr(req, res, method, idPart) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const round = readList("rounds.json").find((row) => String(row.round_id) === String(idPart));
  if (!round) return send(res, 404, { error: "Round not found" });
  const image = roundQr(req, round);
  let download = false;
  try {
    download = new URL(req.url || "/", "http://localhost").searchParams.get("download") === "1";
  } catch (_) {}
  return sendSvg(res, image.svg, download ? "round-" + round.number + "-qr.svg" : "");
}

async function handlePrint(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }
  const event = readJsonFile("event.json", null) || ensureEvent();
  if (pathname === "/print/qr-sheet") {
    const gate = requireAdmin(req);
    if (!gate.ok) return sendHtml(res, gate.status, "<!DOCTYPE html><html><body><p>" + gate.error + "</p></body></html>");
    const cards = readList("rounds.json")
      .slice()
      .sort((a, b) => Number(a.number) - Number(b.number))
      .map((round) => ({ round_id: round.round_id, number: round.number, svg: roundQr(req, round).svg }));
    return sendHtml(res, 200, printPages.renderQrSheet(event.name, cards));
  }
  const organiser = pathname.endsWith("/organiser");
  const number = pathname.slice("/print/round/".length).replace(/\/organiser$/, "");
  if (!/^[1-9]\d*$/.test(number)) {
    return sendHtml(res, 404, "<!DOCTYPE html><html><body><p>Round not found.</p></body></html>");
  }
  if (organiser) {
    const gate = requireAdmin(req);
    if (!gate.ok) return sendHtml(res, gate.status, "<!DOCTYPE html><html><body><p>Login required</p></body></html>");
  }
  const round = readList("rounds.json").find((row) => String(row.number) === String(number));
  if (!round || !roundIsPublic(roundPairings(round.round_id))) {
    return sendHtml(res, 404, "<!DOCTYPE html><html><body><p>Pairings are not published yet.</p></body></html>");
  }
  const sheet = sheetFor(round);
  const markup = organiser ? roundQr(req, round).svg : "";
  return sendHtml(res, 200, printPages.renderRoundPage(sheet, markup));
}

async function handlePairings(req, res, method, idPart) {
  const list = readList("pairings.json");
  if (method === "GET") {
    const gate = requireAdmin(req);
    const rows = gate.ok ? list : list.map(model.publicPairing).filter(Boolean);
    if (idPart == null) return send(res, 200, rows);
    const row = rows.find((pairing) => String(pairing.pairing_id) === String(idPart));
    if (!row) return send(res, 404, { error: "Not found" });
    return send(res, 200, row);
  }
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method === "DELETE") {
    const id = Number(idPart);
    if (!list.some((pairing) => Number(pairing.pairing_id) === id)) return send(res, 404, { error: "Not found" });
    if (readList("results.json").some((result) => Number(result.pairing_id) === id)) {
      return send(res, 409, { error: "A pairing that already has a result cannot be deleted" });
    }
    writeJsonFile("pairings.json", list.filter((pairing) => Number(pairing.pairing_id) !== id));
    return send(res, 200, { ok: true, deleted: id });
  }
  const body = (await readBody(req)) || {};
  const ctx = eventContext();
  if (method === "POST" && idPart == null) {
    const checked = model.validatePairing(body, null, ctx);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    const seated = bindTable(checked.value, ctx.areas);
    if (!seated.ok) return send(res, 400, { error: seated.error });
    seated.pairing.pairing_id = nextId(list, "pairing_id");
    list.push(seated.pairing);
    writeJsonFile("pairings.json", list);
    return send(res, 201, { ...seated.pairing, warnings: tables.tableConflicts(list, seated.pairing.round_id) });
  }
  if (method === "PUT" && idPart != null) {
    const idx = list.findIndex((pairing) => String(pairing.pairing_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const checked = model.validatePairing(body, list[idx], ctx);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    const seated = bindTable(checked.value, ctx.areas);
    if (!seated.ok) return send(res, 400, { error: seated.error });
    seated.pairing.pairing_id = list[idx].pairing_id;
    list[idx] = seated.pairing;
    writeJsonFile("pairings.json", list);
    return send(res, 200, { ...seated.pairing, warnings: tables.tableConflicts(list, seated.pairing.round_id) });
  }
  return send(res, 405, { error: "Method not allowed" });
}

async function handleEventResults(req, res, method, idPart, action) {
  const list = readList("results.json");
  if (method === "GET" && !action) {
    const gate = requireAdmin(req);
    let source = list;
    if (!gate.ok) {
      const published = new Set(
        readList("pairings.json")
          .filter((pairing) => pairing.state === "published")
          .map((pairing) => Number(pairing.pairing_id))
      );
      source = list.filter((result) => result.confirmation === "confirmed" && published.has(Number(result.pairing_id)));
    }
    const rows = gate.ok ? source.map(model.withCampaignPoints) : source.map(publicResultView);
    if (idPart == null) return send(res, 200, rows);
    const row = rows.find((result) => String(result.result_id) === String(idPart));
    if (!row) return send(res, 404, { error: "Not found" });
    return send(res, 200, row);
  }
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method === "POST" && action === "confirm") {
    const idx = list.findIndex((result) => String(result.result_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const body = (await readBody(req)) || {};
    const as = body.as === "opponent" ? "opponent" : "admin";
    const current = list[idx];
    if (current.confirmation !== "pending" && !(current.confirmation === "disputed" && as === "admin")) {
      return send(res, 409, { error: "This result is not waiting for confirmation" });
    }
    const checked = model.validateResult(
      { ...current, confirmation: "confirmed", confirmed_by: as },
      current,
      eventContext()
    );
    if (!checked.ok) return send(res, 409, { error: checked.error });
    checked.value.result_id = current.result_id;
    list[idx] = checked.value;
    writeJsonFile("results.json", list);
    return send(res, 200, checked.value);
  }
  if (method === "POST" && action === "reject") {
    const idx = list.findIndex((result) => String(result.result_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    if (list[idx].confirmation === "disputed") return send(res, 200, list[idx]);
    const checked = model.validateResult(
      { ...list[idx], confirmation: "disputed", confirmed_by: null },
      list[idx],
      eventContext()
    );
    if (!checked.ok) return send(res, 409, { error: checked.error });
    checked.value.result_id = list[idx].result_id;
    list[idx] = checked.value;
    writeJsonFile("results.json", list);
    return send(res, 200, checked.value);
  }
  if (method === "POST" && action === "dispute") {
    const idx = list.findIndex((result) => String(result.result_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    if (list[idx].confirmation !== "pending") return send(res, 409, { error: "Only a pending result can be disputed" });
    list[idx] = { ...list[idx], confirmation: "disputed", confirmed_by: null };
    writeJsonFile("results.json", list);
    return send(res, 200, list[idx]);
  }
  if (method === "DELETE") {
    const id = Number(idPart);
    if (!list.some((result) => Number(result.result_id) === id)) return send(res, 404, { error: "Not found" });
    writeJsonFile("results.json", list.filter((result) => Number(result.result_id) !== id));
    return send(res, 200, { ok: true, deleted: id });
  }
  const body = (await readBody(req)) || {};
  const ctx = eventContext();
  if (method === "POST" && idPart == null) {
    const checked = model.validateResult(body, null, ctx);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    if (list.some((result) => Number(result.pairing_id) === Number(checked.value.pairing_id))) {
      return send(res, 409, { error: "That pairing already has a result" });
    }
    checked.value.result_id = nextId(list, "result_id");
    list.push(checked.value);
    writeJsonFile("results.json", list);
    return send(res, 201, checked.value);
  }
  if (method === "PUT" && idPart != null && !action) {
    const idx = list.findIndex((result) => String(result.result_id) === String(idPart));
    if (idx < 0) return send(res, 404, { error: "Not found" });
    const checked = model.validateResult(body, list[idx], ctx);
    if (!checked.ok) return send(res, 400, { error: checked.error });
    checked.value.result_id = list[idx].result_id;
    list[idx] = checked.value;
    writeJsonFile("results.json", list);
    return send(res, 200, checked.value);
  }
  return send(res, 405, { error: "Method not allowed" });
}

function cleanBlurb(value) {
  if (value == null || String(value).trim() === "") return { ok: true, value: null };
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (text.length > 500) return { ok: false, error: "The recap must be at most 500 characters" };
  if (model.looksLikeContact(text)) return { ok: false, error: "The recap cannot be an email address or a phone number" };
  return { ok: true, value: text };
}

async function handleStandings(req, res, method) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const scored = scoring.scoreState(scoringInput());
  return send(res, 200, {
    complete: scored.complete,
    leader: scored.leader,
    factions: scored.factions,
    loyalists: scored.loyalists,
    traitors: scored.traitors
  });
}

async function handleNarrative(req, res, method) {
  if (method === "GET") {
    const scored = scoring.scoreState(scoringInput());
    const event = readJsonFile("event.json", null) || ensureEvent();
    return send(res, 200, { event_name: event.name, rounds: scored.log });
  }
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  const roundId = Number(body.round_id);
  const rounds = readList("rounds.json");
  if (!rounds.some((round) => Number(round.round_id) === roundId)) return send(res, 404, { error: "Round not found" });
  const blurb = cleanBlurb(body.blurb);
  if (!blurb.ok) return send(res, 400, { error: blurb.error });
  const list = readList("narrative.json").filter((row) => Number(row.round_id) !== roundId);
  if (blurb.value) list.push({ round_id: roundId, blurb: blurb.value });
  writeJsonFile("narrative.json", list);
  return send(res, 200, { round_id: roundId, blurb: blurb.value });
}

function siteTheme() {
  const event = readJsonFile("event.json", null);
  return event && event.theme === "journal-tactica" ? "journal-tactica" : "current";
}

async function handleControl(req, res, method) {
  if (method !== "GET") return send(res, 405, { error: "Area control is calculated from confirmed results" });
  return send(res, 200, scoring.scoreState(scoringInput()).control);
}

async function handleTheme(req, res, method) {
  if (method === "GET") return send(res, 200, { theme: siteTheme() });
  if (method !== "POST" && method !== "PUT") return send(res, 405, { error: "Method not allowed" });
  const gate = requireAdmin(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  const body = (await readBody(req)) || {};
  if (body.theme !== "current" && body.theme !== "journal-tactica") {
    return send(res, 400, { error: "Theme must be current or journal-tactica" });
  }
  const event = readJsonFile("event.json", null) || ensureEvent();
  event.theme = body.theme;
  writeJsonFile("event.json", event);
  return send(res, 200, { theme: event.theme });
}

function projectorPayload() {
  const event = readJsonFile("event.json", null) || ensureEvent();
  const scored = scoring.scoreState(scoringInput());
  const map = readMapFile();
  const rounds = scored.log || [];
  const current = rounds.length ? rounds[rounds.length - 1].number : Number(event.current_round) || 0;
  const highlights = [];
  rounds.slice().reverse().forEach((round) => {
    if (round.blurb) highlights.push("Round " + round.number + ": " + round.blurb);
    (round.battles || []).forEach((battle) => {
      const left = battle.loyalist ? battle.loyalist.display_name : "Loyalist";
      const right = battle.traitor ? battle.traitor.display_name : "Traitor";
      const kind = battle.kind === "apex" ? "Apex" : "Grudge";
      highlights.push("Round " + round.number + " " + kind + ": " + left + " " + battle.loyalist_vp + "–" + battle.traitor_vp + " " + right);
    });
    (round.notes || []).forEach((note) => highlights.push(note.display_name + ": " + note.note));
    (round.areas || []).forEach((area) => {
      if (area.controller !== area.previous && area.controller !== "neutral") {
        highlights.push(area.name + " taken by " + area.controller);
      }
    });
  });
  const areas = (map.areas || []).map((area) => ({
    area_id: area.area_id,
    name: area.name,
    shape: area.shape,
    points: area.points,
    x: area.x,
    y: area.y,
    routes: area.routes || [],
    controller: model.currentAreaController(area.area_id, scored.control, readList("rounds.json"))
  }));
  const neutral = areas.filter((area) => area.controller !== "Loyalist" && area.controller !== "Traitor").length;
  return {
    event_name: event.name,
    current_round: current,
    complete: scored.complete,
    leader: scored.leader,
    factions: {
      Loyalist: scored.factions.Loyalist,
      Traitor: scored.factions.Traitor,
      neutral: { areas: neutral }
    },
    best: {
      loyalist: scored.loyalists[0] || null,
      traitor: scored.traitors[0] || null
    },
    highlights: highlights.slice(0, 8),
    image: map.image ? { file: map.image.file, width: map.image.width, height: map.image.height, url: "/api/map/image" } : null,
    areas
  };
}

function requireAdminGate(req) {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate;
  if (parseCookies(req).sh_session && req.headers["x-sh-request"] !== "1") {
    return { ok: false, status: 403, error: "Write blocked. Refresh the page and try again." };
  }
  return { ok: true };
}

const RESTORE_MAX_BYTES = 12 * 1024 * 1024;

function readLimited(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    }
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(httpError(413, "Backup is too large"));
        setImmediate(() => {
          if (!req.destroyed) req.destroy();
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (err) => finish(err));
  });
}

function buildBackup() {
  const files = {};
  backup.FILE_NAMES.forEach((name) => {
    if (name === "event.json") files[name] = readJsonFile(name, null) || ensureEvent();
    else if (name === "map.json") files[name] = readJsonFile(name, null) || { image: null, areas: [] };
    else if (name === "meta.json") files[name] = readJsonFile(name, null) || { event_name: DEFAULT_META.event_name, blurb: DEFAULT_META.blurb };
    else files[name] = readJsonFile(name, null) || [];
  });
  let mapImage = null;
  const image = files["map.json"] && files["map.json"].image;
  if (image && image.file) {
    const fp = storedMapPath(image.file);
    if (fp && fs.existsSync(fp)) {
      const bytes = fs.readFileSync(fp);
      mapImage = {
        file: image.file,
        mime: image.file.endsWith(".png") ? "image/png" : "image/jpeg",
        data: bytes.toString("base64")
      };
    }
  }
  return {
    format: backup.FORMAT,
    version: backup.VERSION,
    exported_at: new Date().toISOString(),
    files,
    map_image: mapImage
  };
}

function sendCsv(res, filename, text) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(text);
}

async function handleAdminBackup(req, res, method) {
  const gate = requireAdminGate(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const body = JSON.stringify(buildBackup());
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="event-backup.json"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

async function handleAdminRestore(req, res, method) {
  const gate = requireAdminGate(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  let raw;
  try {
    raw = await readLimited(req, RESTORE_MAX_BYTES);
  } catch (err) {
    const status = Number(err && err.status) || 400;
    return send(res, status, { error: err.message || "Backup could not be read" });
  }
  let bundle;
  try {
    bundle = JSON.parse(raw.toString("utf8"));
  } catch (_) {
    return send(res, 400, { error: "Backup must be JSON" });
  }
  const checked = backup.validateBackup(bundle);
  if (!checked.ok) return send(res, 400, { error: checked.error });
  const eventCheck = model.validateEvent(checked.files["event.json"], checked.files["event.json"]);
  if (!eventCheck.ok) return send(res, 400, { error: eventCheck.error });
  checked.files["event.json"] = eventCheck.value;
  if (checked.image) {
    if (checked.image.bytes.length > MAP_IMAGE_MAX_BYTES) return send(res, 400, { error: "Map image is too large" });
    const kind = sniffMapImage(checked.image.bytes);
    if (checked.image.file === "event-map.png" && kind !== "png") return send(res, 400, { error: "Map image is not a PNG" });
    if (checked.image.file === "event-map.jpg" && kind !== "jpeg") return send(res, 400, { error: "Map image is not a JPEG" });
    const size = kind === "png" ? pngSize(checked.image.bytes) : jpegSize(checked.image.bytes);
    checked.files["map.json"].image = Object.assign({ file: checked.image.file }, size || {});
  } else {
    checked.files["map.json"].image = null;
  }
  ensureDataDir();
  backup.FILE_NAMES.forEach((name) => {
    writeJsonFile(name, checked.files[name]);
  });
  const dir = mapImageDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ["event-map.png", "event-map.jpg"].forEach((name) => {
    const fp = storedMapPath(name);
    if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  if (checked.image) {
    const fp = storedMapPath(checked.image.file);
    const tmp = fp + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, checked.image.bytes);
    fs.renameSync(tmp, fp);
  }
  return send(res, 200, { ok: true });
}

async function handleAdminCsv(req, res, method, kind) {
  const gate = requireAdminGate(req);
  if (!gate.ok) return send(res, gate.status, { error: gate.error });
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  if (kind === "standings") {
    return sendCsv(res, "standings.csv", backup.standingsCsv(scoring.scoreState(scoringInput())));
  }
  return sendCsv(
    res,
    "results.csv",
    backup.resultsCsv(readList("results.json"), readList("pairings.json"), readList("players.json"), readList("rounds.json"))
  );
}

async function handleProjector(req, res, method) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  return send(res, 200, projectorPayload());
}

function publicResultView(result) {
  return {
    result_id: result.result_id,
    pairing_id: result.pairing_id,
    round_id: result.round_id,
    loyalist_vp: result.loyalist_vp,
    traitor_vp: result.traitor_vp,
    outcome: result.outcome,
    confirmation: result.confirmation,
    note: result.note || null,
    campaign_points: model.campaignPoints(result)
  };
}

function reportPlayer(players, id) {
  const player = (players || []).find((row) => Number(row.player_id) === Number(id));
  if (!player) return null;
  return { display_name: player.display_name, faction: player.faction, army: player.army || null };
}

function reportGames(round) {
  const players = readList("players.json");
  const areas = readMapFile().areas;
  const results = readList("results.json");
  return roundPairings(round.round_id)
    .filter((pairing) => pairing.kind !== "bye" && pairing.table)
    .map((pairing) => {
      const area = areas.find((item) => Number(item.area_id) === Number(pairing.area_id));
      const result = results.find((item) => Number(item.pairing_id) === Number(pairing.pairing_id));
      return {
        pairing_id: pairing.pairing_id,
        table: pairing.table,
        kind: pairing.kind,
        area: area ? area.name : null,
        scenario: area && area.scenario ? area.scenario : null,
        loyalist: reportPlayer(players, pairing.loyalist_id),
        traitor: reportPlayer(players, pairing.traitor_id),
        status: result ? result.confirmation : "open"
      };
    })
    .sort((a, b) => String(a.table).localeCompare(String(b.table), undefined, { numeric: true }));
}

async function handleReport(req, res, method) {
  const url = new URL(req.url || "/", "http://localhost");
  if (method === "GET") {
    const number = Number(url.searchParams.get("round"));
    const round = readList("rounds.json").find((row) => Number(row.number) === number);
    if (!round) return send(res, 404, { error: "Round not found" });
    const pairings = roundPairings(round.round_id);
    if (!roundIsPublic(pairings)) return send(res, 404, { error: "Pairings are not published yet" });
    const event = readJsonFile("event.json", null) || ensureEvent();
    return send(res, 200, {
      event_name: event.name,
      round: { round_id: round.round_id, number: round.number },
      games: reportGames(round)
    });
  }
  if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
  const locked = reportCodeLocked(req);
  if (locked) return sendRateLimited(res, locked);
  const body = (await readBody(req)) || {};
  const event = readJsonFile("event.json", null) || ensureEvent();
  if (!eventCodesMatch(body.event_code, event.event_code)) {
    noteBadReportCode(req);
    return send(res, 401, { error: "The event code was not accepted" });
  }
  const number = Number(body.round != null ? body.round : url.searchParams.get("round"));
  const round = readList("rounds.json").find((row) => Number(row.number) === number);
  if (!round) return send(res, 404, { error: "Round not found" });
  const pairings = roundPairings(round.round_id);
  if (!roundIsPublic(pairings)) return send(res, 404, { error: "Pairings are not published yet" });
  const pairing = pairings.find((row) => Number(row.pairing_id) === Number(body.pairing_id));
  if (!pairing || pairing.kind === "bye" || !pairing.table) {
    return send(res, 400, { error: pairing && pairing.kind === "bye" ? "A bye is not reported from a table" : "That table is not in this round" });
  }
  const seat = body.seat === "loyalist" || body.seat === "traitor" ? body.seat : "";
  if (!seat || (seat === "loyalist" && !pairing.loyalist_id) || (seat === "traitor" && !pairing.traitor_id)) {
    return send(res, 400, { error: "Choose your name at that table" });
  }
  const ctx = eventContext();
  const checked = model.validateResult(
    {
      pairing_id: pairing.pairing_id,
      round_id: round.round_id,
      loyalist_vp: body.loyalist_vp,
      traitor_vp: body.traitor_vp,
      outcome: body.outcome,
      note: body.note,
      confirmation: "pending",
      reported_by: seat,
      confirmed_by: null
    },
    null,
    ctx
  );
  if (!checked.ok) return send(res, 400, { error: checked.error });
  const list = readList("results.json");
  const idx = list.findIndex((result) => Number(result.pairing_id) === Number(pairing.pairing_id));
  if (idx < 0) {
    checked.value.result_id = nextId(list, "result_id");
    list.push(checked.value);
    writeJsonFile("results.json", list);
    return send(res, 201, { ok: true, status: "pending" });
  }
  const current = list[idx];
  if (current.confirmation === "confirmed") return send(res, 409, { error: "This table already has a confirmed result" });
  if (current.confirmation === "disputed") return send(res, 409, { error: "This table is waiting for the organiser" });
  if (current.reported_by === seat) return send(res, 409, { error: "That side already sent a report for this table" });
  const matches =
    current.outcome === checked.value.outcome &&
    current.loyalist_vp === checked.value.loyalist_vp &&
    current.traitor_vp === checked.value.traitor_vp;
  if (matches) {
    const agreed = model.validateResult(
      { ...current, confirmation: "confirmed", confirmed_by: "opponent" },
      current,
      ctx
    );
    if (!agreed.ok) return send(res, 409, { error: agreed.error });
    agreed.value.result_id = current.result_id;
    list[idx] = agreed.value;
    writeJsonFile("results.json", list);
    return send(res, 200, { ok: true, status: "confirmed" });
  }
  const flagged = model.validateResult({ ...current, confirmation: "disputed", confirmed_by: null }, current, ctx);
  if (!flagged.ok) return send(res, 409, { error: flagged.error });
  flagged.value.result_id = current.result_id;
  flagged.value.counter_loyalist_vp = checked.value.loyalist_vp;
  flagged.value.counter_traitor_vp = checked.value.traitor_vp;
  flagged.value.counter_outcome = checked.value.outcome;
  flagged.value.counter_note = checked.value.note;
  flagged.value.counter_reported_by = seat;
  list[idx] = flagged.value;
  writeJsonFile("results.json", list);
  return send(res, 200, { ok: true, status: "disputed" });
}

async function handlePublic(req, res, parts, method) {
  if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
  const collection = parts[1];
  if (collection === "counts") return send(res, 200, publicCounts());
  if (collection === "meta") return send(res, 200, publicMeta(readCollection("meta")));
  if (collection === "systems") return send(res, 200, readCollection("systems"));
  if (collection === "games") return send(res, 200, readCollection("games").map(publicGame));
  if (collection === "entrants") return send(res, 200, readList("players.json").map(model.publicEntrant));
  if (collection === "event") {
    const event = readJsonFile("event.json", null);
    return send(res, 200, model.publicEvent(event || ensureEvent()));
  }
  if (collection === "map") return send(res, 200, presentMap(readMapFile()));
  return send(res, 404, { error: "Unknown public collection" });
}

async function handleApi(req, res, pathname) {
  const parts = pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method;
  if (method === "OPTIONS") return send(res, 204, "");
  const csrf = assertCsrf(req);
  if (csrf) return send(res, 403, { error: csrf });

  if (parts[0] === "auth") return handleAuth(req, res, parts, method);
  if (parts[0] === "public") return handlePublic(req, res, parts, method);

  if (["forces", "invites", "roster", "actions", "campaign", "feedback", "inbox"].includes(parts[0])) {
    return send(res, 404, { error: "Not part of this event" });
  }

  if (parts[0] === "event" && parts.length === 1) return handleEvent(req, res, method);
  if (parts[0] === "map" && parts[1] === "image" && parts.length === 2) return handleMapUpload(req, res, method);
  if (parts[0] === "map" && parts.length === 1) return handleMapImage(req, res, method);
  if (parts[0] === "areas") return handleAreas(req, res, method, parts[1]);
  if (parts[0] === "players") return handlePlayers(req, res, method, parts[1]);
  if (parts[0] === "rounds" && parts[2] === "pair" && parts.length === 3) return handleGenerateRound(req, res, method, parts[1]);
  if (parts[0] === "rounds" && parts[2] === "sheet" && parts.length === 3) return handleRoundSheet(req, res, method, parts[1]);
  if (parts[0] === "rounds" && parts[2] === "qr.svg" && parts.length === 3) return handleRoundQr(req, res, method, parts[1]);
  if (parts[0] === "rounds" && parts[2] === "approve" && parts.length === 3) return handleRoundState(req, res, method, parts[1], "approved");
  if (parts[0] === "rounds" && parts[2] === "publish" && parts.length === 3) return handleRoundState(req, res, method, parts[1], "published");
  if (parts[0] === "rounds") return handleRounds(req, res, method, parts[1]);
  if (parts[0] === "pairings") return handlePairings(req, res, method, parts[1]);
  if (parts[0] === "results") return handleEventResults(req, res, method, parts[1], parts[2]);
  if (parts[0] === "report" && parts.length === 1) return handleReport(req, res, method);
  if (parts[0] === "control") return handleControl(req, res, method);
  if (parts[0] === "theme" && parts.length === 1) return handleTheme(req, res, method);
  if (parts[0] === "projector" && parts.length === 1) return handleProjector(req, res, method);
  if (parts[0] === "admin" && parts[1] === "backup" && parts.length === 2) return handleAdminBackup(req, res, method);
  if (parts[0] === "admin" && parts[1] === "restore" && parts.length === 2) return handleAdminRestore(req, res, method);
  if (parts[0] === "admin" && parts[1] === "standings.csv" && parts.length === 2) return handleAdminCsv(req, res, method, "standings");
  if (parts[0] === "admin" && parts[1] === "results.csv" && parts.length === 2) return handleAdminCsv(req, res, method, "results");
  if (parts[0] === "standings" && parts.length === 1) return handleStandings(req, res, method);
  if (parts[0] === "narrative" && parts.length === 1) return handleNarrative(req, res, method);

  if (parts[0] === "games" && method === "POST" && parts[2] === "confirm") {
    return confirmResult(req, res, parts[1]);
  }
  if (parts[0] === "games" && method === "POST" && parts[2] === "dispute") {
    return disputeResult(req, res, parts[1]);
  }
  if (parts[0] === "games" && method === "POST" && parts[2] === "void") {
    return voidResult(req, res, parts[1]);
  }

  if (parts[0] === "systems") {
    if (method === "GET") {
      const list = readCollection("systems");
      if (parts[1] == null) return send(res, 200, list);
      const row = list.find((item) => String(item.sys_id) === String(parts[1]));
      if (!row) return send(res, 404, { error: "Not found" });
      return send(res, 200, row);
    }
    return handleSystemsWrite(req, res, method, parts[1]);
  }

  if (parts[0] === "games") {
    if (method === "GET") {
      const list = readCollection("games").map(publicGame);
      if (parts[1] == null) return send(res, 200, list);
      const row = list.find((item) => String(item.game_id) === String(parts[1]));
      if (!row) return send(res, 404, { error: "Not found" });
      return send(res, 200, row);
    }
    return handleGamesWrite(req, res, method, parts[1]);
  }

  if (parts[0] === "meta") {
    if (method === "GET") {
      const gate = requireAdmin(req);
      if (!gate.ok) return send(res, 200, publicMeta(readCollection("meta")));
      return send(res, 200, publicMeta(readCollection("meta")));
    }
    if (method === "PUT" || method === "POST") return handleMetaWrite(req, res);
  }

  return send(res, 404, { error: "Unknown route" });
}

function logRequest(req, res, pathname, started) {
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(new Date().toISOString() + " " + req.method + " " + pathname + " " + res.statusCode + " " + ms + "ms");
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = "/";
  try {
    const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
    pathname = decodeURIComponent(url.pathname);
    logRequest(req, res, pathname, started);
    if (pathname === "/health" || pathname === "/api/health") {
      send(res, 200, { ok: true, service: "weekend-narrative-map" });
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }
    if (pathname === "/projector") {
      serveStatic(req, res, "/projector.html");
      return;
    }
    if (pathname === "/print/qr-sheet" || pathname.startsWith("/print/round/")) {
      await handlePrint(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return;
    try {
      send(res, status, { error: status >= 500 ? "Server error" : err.message || "Request failed" });
    } catch (_) {
      res.writeHead(500);
      res.end("Server error");
    }
  }
});

function boot() {
  const decision = evaluateDataDirectory(process.env, ROOT);
  decision.warnings.forEach((line) => console.warn(line));
  if (!decision.ok) {
    decision.errors.forEach((line) => console.error(line));
    process.exit(1);
  }
  ensureDataDir();
  seedBaselineSystems();
  seedDefaultMeta();
  migrateImportedMap();
  ensureEvent();
  noteIgnoredSampleSeed();
  bootstrapAdmin();
}

function startServer() {
  server.listen(PORT, HOST, () => {
    const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log("Weekend Event Narrative Map http://" + shownHost + ":" + PORT);
    console.log("Data directory: " + DATA);
    console.log("Roles: visitor · admin");
    console.log("Login: POST /api/auth/login  ·  Me: GET /api/auth/me");
    console.log("Public data: /api/public/{counts|systems|games|meta}");
    console.log("Health: /health");
  });
}

if (require.main === module) {
  boot();
  startServer();
}

module.exports = { evaluateDataDirectory };
