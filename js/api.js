/**
 * Shared data client and admin auth for the weekend event map.
 * There is no player login. Visitors read the map and results.
 * The event admin signs in and edits nodes, routes, and results.
 */
(function (global) {
  const ID_KEYS = {
    systems: "sys_id",
    games: "game_id",
    meta: null
  };

  let mode = "local";
  let probed = false;
  let token = null;
  let meCache = { authenticated: false, role: "visitor" };
  let publicMetaCache = null;

  try {
    token = localStorage.getItem("sh_session_token") || null;
  } catch (_) {}

  function apiBase() {
    if (typeof location !== "undefined" && location.protocol.startsWith("http")) return "";
    return "http://localhost:3847";
  }

  function authHeaders() {
    const h = { "Content-Type": "application/json", "X-SH-Request": "1" };
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  // One in-flight probe. The map starts its load and applyNavPermissions()
  // together; marking probed before refreshMe() paints a signed-out header
  // and never comes back.
  let probePromise = null;

  async function probe() {
    if (probed) return mode;
    if (!probePromise) probePromise = runProbe();
    return probePromise;
  }

  async function runProbe() {
    try {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(apiBase() + "/api/public/meta", {
          signal: ctrl.signal,
          cache: "no-store",
          credentials: "include"
        });
        clearTimeout(t);
        if (res.ok) {
          mode = "server";
          publicMetaCache = await res.json().catch(() => ({}));
          await refreshMe();
          return mode;
        }
      } catch (_) {}
      mode = "local";
      meCache = { authenticated: false, role: "visitor" };
      return mode;
    } finally {
      probed = true;
      probePromise = null;
    }
  }

  async function refreshMe() {
    if (mode !== "server") return meCache;
    try {
      const res = await fetch(apiBase() + "/api/auth/me", {
        headers: authHeaders(),
        credentials: "include",
        cache: "no-store"
      });
      if (res.ok) meCache = await res.json();
      else meCache = { authenticated: false, role: "visitor" };
    } catch (_) {
      meCache = { authenticated: false, role: "visitor" };
    }
    return meCache;
  }

  function localKey(collection) {
    return "weekend_event_" + collection + "_v1";
  }

  function localRead(collection) {
    try {
      const raw = localStorage.getItem(localKey(collection));
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return collection === "meta"
      ? { event_name: "Weekend Event", blurb: "A one-weekend Horus Heresy narrative tournament." }
      : [];
  }

  function localWrite(collection, data) {
    localStorage.setItem(localKey(collection), JSON.stringify(data));
  }

  async function request(path, options) {
    const res = await fetch(apiBase() + path, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: { ...authHeaders(), ...(options && options.headers) }
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { error: text };
      }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || "Request failed");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function list(collection) {
    await probe();
    if (mode !== "server") return localRead(collection);
    return request("/api/public/" + collection, { method: "GET" });
  }

  async function getMeta() {
    await probe();
    if (mode !== "server") return localRead("meta");
    publicMetaCache = await request("/api/public/meta", { method: "GET" });
    return publicMetaCache;
  }

  async function save(collection, row) {
    await probe();
    if (mode !== "server") {
      if (collection === "meta") {
        localWrite("meta", row);
        return row;
      }
      const idKey = ID_KEYS[collection];
      const listRows = localRead(collection);
      const id = row[idKey];
      const idx = listRows.findIndex((item) => String(item[idKey]) === String(id));
      if (id == null || id === "" || idx < 0) {
        row[idKey] = listRows.reduce((max, item) => Math.max(max, Number(item[idKey]) || 0), 0) + 1;
        listRows.push(row);
      } else listRows[idx] = row;
      localWrite(collection, listRows);
      return row;
    }
    const idKey = ID_KEYS[collection];
    if (collection === "meta") return request("/api/meta", { method: "PUT", body: JSON.stringify(row) });
    const id = row[idKey];
    if (id == null || id === "") {
      return request("/api/" + collection, { method: "POST", body: JSON.stringify(row) });
    }
    return request("/api/" + collection + "/" + encodeURIComponent(id), {
      method: "PUT",
      body: JSON.stringify(row)
    });
  }

  async function remove(collection, id) {
    await probe();
    if (mode !== "server") {
      const idKey = ID_KEYS[collection];
      localWrite(
        collection,
        localRead(collection).filter((item) => String(item[idKey]) !== String(id))
      );
      return { ok: true };
    }
    return request("/api/" + collection + "/" + encodeURIComponent(id), { method: "DELETE" });
  }

  async function postAction(path, body) {
    await probe();
    return request(path, { method: "POST", body: JSON.stringify(body || {}) });
  }

  async function login(creds) {
    await probe();
    const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify(creds || {}) });
    token = data.token || null;
    try {
      if (token) localStorage.setItem("sh_session_token", token);
    } catch (_) {}
    meCache = { authenticated: true, ...data };
    return meCache;
  }

  async function logout() {
    try {
      await request("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (_) {}
    token = null;
    meCache = { authenticated: false, role: "visitor" };
    try {
      localStorage.removeItem("sh_session_token");
    } catch (_) {}
  }

  async function setPassword(body) {
    return request("/api/auth/set-password", { method: "POST", body: JSON.stringify(body || {}) });
  }

  function isLoggedIn() {
    return !!(meCache && meCache.authenticated && meCache.role === "campaign_admin");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function navAuthHtml() {
    if (!isLoggedIn()) return '<a class="nav-login" href="login.html">Log in</a>';
    return '<span class="nav-account">Admin</span>';
  }

  function statusBadgeHtml() {
    const kind = mode === "server" ? "server" : "local";
    const label = mode === "server" ? "Live" : "Offline";
    return '<span class="mode-badge ' + kind + '">' + label + "</span>";
  }

  function applyEventChrome(meta) {
    const name = (meta && meta.event_name) || "Weekend Event";
    document.querySelectorAll("[data-event-name]").forEach((el) => {
      el.textContent = name;
    });
    document.querySelectorAll("[data-event-blurb]").forEach((el) => {
      if (meta && meta.blurb) el.textContent = meta.blurb;
    });
  }

  function wireSiteMenu() {
    const header = document.querySelector(".site-header");
    const toggle = document.querySelector(".nav-toggle");
    const menu = document.getElementById("site-menu");
    if (!header || !toggle || !menu || toggle.dataset.wired) return;
    toggle.dataset.wired = "1";
    function setOpen(open) {
      header.classList.toggle("menu-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    }
    toggle.addEventListener("click", () => setOpen(!header.classList.contains("menu-open")));
    document.addEventListener("click", (e) => {
      if (!header.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") setOpen(false);
    });
    const path = (location.pathname || "").split("/").pop() || "index.html";
    menu.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (href === path || (path === "" && href === "index.html")) a.classList.add("active");
    });
  }

  async function applyNavPermissions() {
    await probe();
    const role = meCache.role || "visitor";
    document.querySelectorAll("[data-role]").forEach((el) => {
      const need = (el.getAttribute("data-role") || "").split(/\s+/);
      const ok = need.some((r) => r === role || (r === "logged-in" && isLoggedIn()));
      el.hidden = !ok;
    });
    const slot = document.getElementById("nav-auth");
    if (slot) slot.innerHTML = navAuthHtml();
    const logoutBtn = document.getElementById("nav-logout");
    if (logoutBtn) {
      logoutBtn.hidden = !isLoggedIn();
      if (!logoutBtn.dataset.wired) {
        logoutBtn.dataset.wired = "1";
        logoutBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          await global.SH.logout();
          location.href = "index.html";
        });
      }
    }
    const badge = document.getElementById("mode-slot");
    if (badge && !badge.querySelector(".mode-badge")) badge.innerHTML = statusBadgeHtml();
    applyEventChrome(publicMetaCache || {});
  }

  global.SH = {
    list,
    getMeta,
    save,
    remove,
    login,
    logout,
    setPassword,
    confirmGame: (id, as) => postAction("/api/games/" + encodeURIComponent(id) + "/confirm", { as: as || "admin" }),
    disputeGame: (id, note) => postAction("/api/games/" + encodeURIComponent(id) + "/dispute", { note: note || "" }),
    voidGame: (id) => postAction("/api/games/" + encodeURIComponent(id) + "/void", {}),
    probe,
    refreshMe,
    applyNavPermissions,
    navAuthHtml,
    statusBadgeHtml,
    isLoggedIn,
    escapeHtml,
    get mode() {
      return mode;
    },
    get role() {
      return meCache.role || "visitor";
    },
    get user() {
      return meCache;
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireSiteMenu);
  else wireSiteMenu();
})(typeof window !== "undefined" ? window : globalThis);
