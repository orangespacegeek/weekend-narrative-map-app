/**
 * Node-and-route map. Positions and routes come from the systems list.
 * Influence, occupation, and force markers are not drawn.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const BASE_W = 800;
  const BASE_H = 560;
  const TAP_SLOP = 10;

  let systems = [];
  let selectedId = null;

  const svg = document.getElementById("map");
  const starsG = document.getElementById("stars");
  const linksG = document.getElementById("links");
  const nodesG = document.getElementById("nodes");
  const mapWrap = document.getElementById("map-wrap");
  const sheet = document.getElementById("sheet");

  function esc(s) {
    return window.SH ? SH.escapeHtml(s) : String(s ?? "");
  }

  function parseLinks(raw) {
    if (Array.isArray(raw)) return raw.map(Number).filter((n) => n > 0);
    if (raw == null || raw === "") return [];
    return String(raw)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
  }

  function byId(id) {
    return systems.find((s) => Number(s.sys_id) === Number(id));
  }

  function pos(s) {
    const x = Number(s.sys_x);
    const y = Number(s.sys_y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    return { x: 400, y: 280 };
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function drawStars() {
    starsG.replaceChildren();
    for (let i = 0; i < 80; i++) {
      starsG.appendChild(
        svgEl("circle", {
          cx: Math.random() * BASE_W,
          cy: Math.random() * BASE_H,
          r: Math.random() * 1.2 + 0.3
        })
      );
    }
  }

  function drawLinks() {
    linksG.replaceChildren();
    const seen = new Set();
    systems.forEach((s) => {
      parseLinks(s.sys_links).forEach((otherId) => {
        const a = Number(s.sys_id);
        const b = Number(otherId);
        if (a === b) return;
        const key = a < b ? a + "-" + b : b + "-" + a;
        if (seen.has(key)) return;
        seen.add(key);
        const sa = byId(a);
        const sb = byId(b);
        if (!sa || !sb) return;
        const pa = pos(sa);
        const pb = pos(sb);
        linksG.appendChild(svgEl("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "link" }));
      });
    });
  }

  function drawNodes() {
    nodesG.replaceChildren();
    systems.forEach((s) => {
      const p = pos(s);
      const g = svgEl("g", { class: "node", "data-id": String(s.sys_id) });
      g.appendChild(svgEl("circle", { cx: p.x, cy: p.y, r: 36, fill: "transparent" }));
      g.appendChild(svgEl("circle", { class: "main", cx: p.x, cy: p.y, r: 20 }));
      const mark = svgEl("text", { class: "type", x: p.x, y: p.y });
      mark.textContent = String(s.sys_name || "?").trim().charAt(0).toUpperCase() || "?";
      g.appendChild(mark);
      const label = svgEl("text", { class: "label", x: p.x, y: p.y + 34 });
      label.textContent = s.sys_name || "Node";
      g.appendChild(label);
      nodesG.appendChild(g);
    });
  }

  function routeNames(s) {
    return parseLinks(s.sys_links)
      .map((id) => (byId(id) || {}).sys_name || "#" + id)
      .join(", ");
  }

  function showMapProblem(message) {
    const banner = document.getElementById("map-alert");
    if (banner) {
      banner.hidden = false;
      banner.textContent = message;
    }
    const empty = document.getElementById("empty-msg");
    if (empty) {
      empty.hidden = false;
      empty.textContent = message;
    }
    const detail = document.getElementById("detail");
    if (detail) detail.hidden = true;
    sheet.classList.add("open");
  }

  function adminTools() {
    const add = document.getElementById("add-node");
    if (add) add.hidden = !(window.SH && SH.isLoggedIn());
  }

  function selectSystem(id) {
    const s = byId(id);
    if (!s) return;
    selectedId = Number(id);
    document.querySelectorAll(".node").forEach((n) =>
      n.classList.toggle("selected", Number(n.dataset.id) === selectedId)
    );
    document.getElementById("empty-msg").hidden = true;
    document.getElementById("detail").hidden = false;
    document.getElementById("sheet-title").textContent = s.sys_name;
    const view = document.getElementById("node-view");
    const form = document.getElementById("node-form");
    const admin = window.SH && SH.isLoggedIn();
    view.hidden = admin;
    form.hidden = !admin;
    if (!admin) {
      view.innerHTML =
        "<dl class='meta'><dt>Routes</dt><dd>" +
        esc(routeNames(s) || "None") +
        "</dd><dt>Notes</dt><dd>" +
        esc(s.sys_notes || "—") +
        "</dd></dl>";
    } else {
      form.sys_name.value = s.sys_name || "";
      form.sys_x.value = s.sys_x;
      form.sys_y.value = s.sys_y;
      form.sys_notes.value = s.sys_notes || "";
      const box = document.getElementById("route-picks");
      box.replaceChildren();
      systems
        .filter((other) => Number(other.sys_id) !== selectedId)
        .forEach((other) => {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = String(other.sys_id);
          input.checked = parseLinks(s.sys_links).includes(Number(other.sys_id));
          label.append(input, document.createTextNode(other.sys_name || "Node " + other.sys_id));
          box.appendChild(label);
        });
      document.getElementById("delete-node").hidden = false;
    }
    sheet.classList.add("open");
  }

  document.getElementById("close-sheet").addEventListener("click", () => {
    sheet.classList.remove("open");
    selectedId = null;
    document.querySelectorAll(".node").forEach((n) => n.classList.remove("selected"));
  });

  document.getElementById("node-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("node-msg");
    const form = e.currentTarget;
    const links = [...form.querySelectorAll("#route-picks input:checked")].map((input) => input.value);
    const row = {
      sys_id: selectedId,
      sys_name: form.sys_name.value,
      sys_x: form.sys_x.value,
      sys_y: form.sys_y.value,
      sys_notes: form.sys_notes.value,
      sys_links: links.join(",")
    };
    msg.textContent = "Saving…";
    msg.className = "msg";
    try {
      const creating = selectedId == null;
      if (creating) delete row.sys_id;
      const saved = await SH.save("systems", row);
      await reload();
      selectSystem(saved.sys_id);
      msg.textContent = "Saved";
      msg.className = "msg ok";
    } catch (err) {
      msg.textContent = err.message || "Could not save";
      msg.className = "msg err";
    }
  });

  document.getElementById("delete-node").addEventListener("click", async () => {
    if (selectedId == null) return;
    const msg = document.getElementById("node-msg");
    if (!confirm("Delete this node and its routes?")) return;
    try {
      await SH.remove("systems", selectedId);
      selectedId = null;
      sheet.classList.remove("open");
      await reload();
    } catch (err) {
      msg.textContent = err.message || "Could not delete";
      msg.className = "msg err";
    }
  });

  document.getElementById("add-node").addEventListener("click", () => {
    if (!window.SH || !SH.isLoggedIn()) return;
    selectedId = null;
    document.querySelectorAll(".node").forEach((n) => n.classList.remove("selected"));
    document.getElementById("empty-msg").hidden = true;
    document.getElementById("detail").hidden = false;
    document.getElementById("sheet-title").textContent = "New node";
    document.getElementById("node-view").hidden = true;
    const form = document.getElementById("node-form");
    form.hidden = false;
    form.sys_name.value = "";
    form.sys_x.value = 400;
    form.sys_y.value = 280;
    form.sys_notes.value = "";
    const box = document.getElementById("route-picks");
    box.replaceChildren();
    systems.forEach((other) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(other.sys_id);
      label.append(input, document.createTextNode(other.sys_name || "Node " + other.sys_id));
      box.appendChild(label);
    });
    document.getElementById("delete-node").hidden = true;
    sheet.classList.add("open");
    form.sys_name.focus();
  });

  let vb = { x: 0, y: 0, w: BASE_W, h: BASE_H };
  const MIN_W = BASE_W / 3.5;
  const MAX_W = BASE_W / 0.7;
  const pointers = new Map();
  let gesture = "none";
  let pinchDist = 0;
  let lastTap = 0;

  function applyViewBox() {
    svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
  }

  function clientToSvg(clientX, clientY) {
    const rect = mapWrap.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return { x: vb.x + sx * vb.w, y: vb.y + sy * vb.h };
  }

  function getDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function nodeNear(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const direct = el && el.closest ? el.closest(".node") : null;
    if (direct) return direct;
    const pt = clientToSvg(clientX, clientY);
    const rect = mapWrap.getBoundingClientRect();
    const px = rect.width / (vb.w || 1);
    const slop = 28 / (px || 1);
    let best = null;
    let bestD = slop;
    document.querySelectorAll("#nodes .node").forEach((n) => {
      const s = byId(Number(n.dataset.id));
      if (!s) return;
      const p = pos(s);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    });
    return best;
  }

  function hideHint() {
    const hint = document.getElementById("map-hint");
    if (hint) hint.style.opacity = "0";
  }

  mapWrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest && e.target.closest("button, a, input, textarea, label")) return;
    if (e.button != null && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    if (pointers.size === 1) gesture = "maybe";
    else if (pointers.size >= 2) {
      gesture = "pinch";
      const pts = [...pointers.values()];
      pinchDist = getDist(pts[0], pts[1]);
    }
  });

  mapWrap.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const curr = { x: e.clientX, y: e.clientY, sx: prev.sx, sy: prev.sy };
      pointers.set(e.pointerId, curr);
      if (gesture === "maybe" && pointers.size === 1) {
        if (Math.hypot(curr.x - curr.sx, curr.y - curr.sy) > TAP_SLOP) {
          gesture = "pan";
          hideHint();
        }
      }
      if (gesture === "pan" && pointers.size === 1) {
        e.preventDefault();
        const rect = mapWrap.getBoundingClientRect();
        vb.x -= (curr.x - prev.x) * (vb.w / rect.width);
        vb.y -= (curr.y - prev.y) * (vb.h / rect.height);
        applyViewBox();
      } else if (gesture === "pinch" && pointers.size === 2) {
        e.preventDefault();
        const pts = [...pointers.values()];
        const dist = getDist(pts[0], pts[1]);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        if (pinchDist > 0) {
          let newW = vb.w * (pinchDist / dist);
          newW = Math.min(MAX_W, Math.max(MIN_W, newW));
          const midSvg = clientToSvg(mid.x, mid.y);
          const rect = mapWrap.getBoundingClientRect();
          const sx = (mid.x - rect.left) / rect.width;
          const sy = (mid.y - rect.top) / rect.height;
          vb.w = newW;
          vb.h = BASE_H * (newW / BASE_W);
          vb.x = midSvg.x - sx * vb.w;
          vb.y = midSvg.y - sy * vb.h;
          applyViewBox();
        }
        pinchDist = dist;
        hideHint();
      }
    },
    { passive: false }
  );

  function endPointer(e, allowTap) {
    const p = pointers.get(e.pointerId);
    const dist = p ? Math.hypot(e.clientX - p.sx, e.clientY - p.sy) : 999;
    const isTap = allowTap && gesture === "maybe" && dist < TAP_SLOP;
    pointers.delete(e.pointerId);
    if (isTap) {
      const node = nodeNear(e.clientX, e.clientY);
      if (node) selectSystem(Number(node.dataset.id));
      const now = Date.now();
      if (!node && now - lastTap < 300) {
        vb = { x: 0, y: 0, w: BASE_W, h: BASE_H };
        applyViewBox();
      }
      lastTap = now;
    }
    if (pointers.size === 0) {
      gesture = "none";
      pinchDist = 0;
    } else if (pointers.size === 1) {
      gesture = "maybe";
      pinchDist = 0;
    }
  }

  mapWrap.addEventListener("pointerup", (e) => endPointer(e, true));
  mapWrap.addEventListener("pointercancel", (e) => endPointer(e, false));
  mapWrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      const newW = Math.min(MAX_W, Math.max(MIN_W, vb.w * factor));
      const midSvg = clientToSvg(e.clientX, e.clientY);
      const rect = mapWrap.getBoundingClientRect();
      const sx = (e.clientX - rect.left) / rect.width;
      const sy = (e.clientY - rect.top) / rect.height;
      vb.w = newW;
      vb.h = BASE_H * (newW / BASE_W);
      vb.x = midSvg.x - sx * vb.w;
      vb.y = midSvg.y - sy * vb.h;
      applyViewBox();
    },
    { passive: false }
  );

  async function reload() {
    const rows = await SH.list("systems");
    systems = Array.isArray(rows) ? rows : [];
    drawLinks();
    drawNodes();
    adminTools();
  }

  async function loadMap() {
    await SH.probe();
    if (window.SH) SH.applyNavPermissions();
    await reload();
    applyViewBox();
    adminTools();
    if (!systems.length) {
      showMapProblem("No nodes yet. An admin can add the first one.");
      return;
    }
    const banner = document.getElementById("map-alert");
    if (banner) banner.hidden = true;
  }

  loadMap().catch((err) => {
    showMapProblem(err && err.message ? err.message : "Could not load the map.");
  });
})();
