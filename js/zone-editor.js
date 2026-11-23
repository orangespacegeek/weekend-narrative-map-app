/**
 * Touch-friendly zone editor. Rectangles and polygons are saved as outlines
 * on the uploaded image. Routes are area ids. Only the event admin can save.
 */
(function () {
  const board = document.getElementById("board");
  const routesG = document.getElementById("routes");
  const areasG = document.getElementById("areas");
  const labelsG = document.getElementById("labels");
  const handlesG = document.getElementById("handles");
  const draftG = document.getElementById("draft");
  const NS = "http://www.w3.org/2000/svg";
  const form = document.getElementById("area-form");
  const msg = document.getElementById("msg");

  let image = null;
  let areas = [];
  let mode = "select";
  let selected = null;
  let draft = [];
  let drag = null;
  let routeFrom = null;

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function uid() {
    return areas.reduce((max, area) => Math.max(max, Number(area.area_id) || 0), 0) + 1;
  }

  function centroid(area) {
    const pts = area.points || [];
    if (!pts.length) return { x: 0, y: 0 };
    return {
      x: pts.reduce((sum, point) => sum + Number(point.x), 0) / pts.length,
      y: pts.reduce((sum, point) => sum + Number(point.y), 0) / pts.length
    };
  }

  function byId(id) {
    return areas.find((area) => Number(area.area_id) === Number(id));
  }

  function svgPoint(event) {
    const point = board.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = board.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const mapped = point.matrixTransform(ctm.inverse());
    return { x: Math.round(mapped.x * 10) / 10, y: Math.round(mapped.y * 10) / 10 };
  }

  function inside(area, point) {
    const pts = area.points || [];
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i].y;
      const yj = pts[j].y;
      const xi = pts[i].x;
      const xj = pts[j].x;
      const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-9) + xi;
      if (intersect) hit = !hit;
    }
    return hit;
  }

  function areaAt(point) {
    for (let i = areas.length - 1; i >= 0; i--) {
      if (inside(areas[i], point)) return areas[i];
    }
    return null;
  }

  function bbox(area) {
    const pts = area.points || [];
    const xs = pts.map((point) => point.x);
    const ys = pts.map((point) => point.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  function isRect(area) {
    const pts = area.points || [];
    if (pts.length !== 4) return false;
    const xs = [...new Set(pts.map((point) => point.x))];
    const ys = [...new Set(pts.map((point) => point.y))];
    return xs.length === 2 && ys.length === 2;
  }

  function nodePos(points) {
    const width = (image && image.width) || 800;
    const height = (image && image.height) || 560;
    const c = centroid({ points });
    return {
      x: Math.round(Math.min(800, Math.max(0, (c.x / width) * 800)) * 10) / 10,
      y: Math.round(Math.min(560, Math.max(0, (c.y / height) * 560)) * 10) / 10
    };
  }

  function draw() {
    const width = (image && image.width) || 800;
    const height = (image && image.height) || 560;
    board.setAttribute("viewBox", "0 0 " + width + " " + height);
    let picture = board.querySelector("image");
    if (image && image.url) {
      if (!picture) {
        picture = el("image", {});
        board.insertBefore(picture, routesG);
      }
      picture.setAttribute("href", image.url + "?t=" + (image.stamp || ""));
      picture.setAttribute("width", String(width));
      picture.setAttribute("height", String(height));
    } else if (picture) picture.remove();
    routesG.replaceChildren();
    areasG.replaceChildren();
    labelsG.replaceChildren();
    handlesG.replaceChildren();
    draftG.replaceChildren();
    const seen = new Set();
    areas.forEach((area) => {
      (area.routes || []).forEach((otherId) => {
        const a = Number(area.area_id);
        const b = Number(otherId);
        const key = a < b ? a + "-" + b : b + "-" + a;
        if (seen.has(key)) return;
        seen.add(key);
        const other = byId(b);
        if (!other) return;
        const pa = centroid(area);
        const pb = centroid(other);
        routesG.appendChild(el("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "route-line" }));
      });
    });
    const font = Math.max(14, Math.round(width / 40));
    areas.forEach((area) => {
      if (!area.points || area.points.length < 3) return;
      const shape = el("polygon", {
        points: (area.points || []).map((point) => point.x + "," + point.y).join(" "),
        class: "area-shape neutral" + (selected === area.area_id ? " selected" : ""),
        "data-id": String(area.area_id)
      });
      areasG.appendChild(shape);
      const at = centroid(area);
      const label = el("text", { x: at.x, y: at.y, class: "area-label", "font-size": String(font) });
      label.textContent = area.name || "Area";
      labelsG.appendChild(label);
    });
    if (draft.length) {
      draftG.appendChild(el("polyline", {
        points: draft.map((point) => point.x + "," + point.y).join(" "),
        class: "area-shape draft"
      }));
    }
    const current = byId(selected);
    if (current && isRect(current)) {
      const box = bbox(current);
      const size = Math.max(18, width / 28);
      handlesG.appendChild(el("rect", {
        x: box.maxX - size / 2,
        y: box.maxY - size / 2,
        width: size,
        height: size,
        class: "handle",
        "data-handle": "resize"
      }));
    }
    fillForm();
  }

  function fillForm() {
    const area = byId(selected);
    form.hidden = !area;
    if (!area) return;
    form.name.value = area.name || "";
    form.tables.value = (area.tables || []).join(", ");
    form.scenario.value = area.scenario || "";
  }

  function readForm() {
    const area = byId(selected);
    if (!area) return;
    area.name = form.name.value.trim() || area.name;
    area.tables = form.tables.value.split(",").map((part) => part.trim()).filter(Boolean);
    area.scenario = form.scenario.value.trim() || null;
    draw();
  }

  form.addEventListener("input", readForm);

  function addArea(points) {
    const pos = nodePos(points);
    const area = {
      area_id: uid(),
      name: "Area " + (areas.length + 1),
      shape: "outline",
      points,
      x: pos.x,
      y: pos.y,
      routes: [],
      tables: [],
      scenario: null,
      notes: ""
    };
    areas.push(area);
    selected = area.area_id;
    mode = "select";
    setMode("select");
    draw();
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", button.getAttribute("data-mode") === mode ? "true" : "false");
    });
    routeFrom = null;
    if (mode !== "poly") draft = [];
    draw();
  }

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.getAttribute("data-mode")));
  });

  document.getElementById("close-shape").addEventListener("click", () => {
    if (draft.length < 3) {
      msg.textContent = "A polygon needs at least three points.";
      return;
    }
    addArea(draft.slice());
    draft = [];
    msg.textContent = "";
  });

  document.getElementById("delete-area").addEventListener("click", () => {
    if (selected == null) return;
    const id = Number(selected);
    areas = areas
      .filter((area) => Number(area.area_id) !== id)
      .map((area) => ({ ...area, routes: (area.routes || []).filter((routeId) => Number(routeId) !== id) }));
    selected = null;
    draw();
  });

  document.getElementById("upload").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    msg.textContent = "Uploading…";
    try {
      const saved = await SH.uploadMap(file);
      image = saved.image;
      if (image) image.stamp = Date.now();
      msg.textContent = "Map image saved.";
      draw();
    } catch (err) {
      msg.textContent = err.message || "Upload failed";
    }
  });

  document.getElementById("save").addEventListener("click", async () => {
    msg.textContent = "Saving areas…";
    try {
      const saved = await SH.saveAreas(areas);
      areas = saved.areas || areas;
      image = saved.image || image;
      msg.textContent = "Saved.";
      draw();
    } catch (err) {
      msg.textContent = err.message || "Could not save";
    }
  });

  function onRect(point) {
    const box = bbox({ points: [drag.origin, point] });
    if (Math.abs(box.maxX - box.minX) < 8 || Math.abs(box.maxY - box.minY) < 8) return;
    addArea([
      { x: box.minX, y: box.minY },
      { x: box.maxX, y: box.minY },
      { x: box.maxX, y: box.maxY },
      { x: box.minX, y: box.maxY }
    ]);
  }

  board.addEventListener("pointerdown", (event) => {
    if (!image) return;
    board.setPointerCapture(event.pointerId);
    const point = svgPoint(event);
    if (mode === "rect") {
      drag = { kind: "rect", origin: point };
      return;
    }
    if (mode === "poly") {
      draft.push(point);
      draw();
      return;
    }
    const handle = event.target.closest && event.target.closest("[data-handle]");
    const area = byId(selected);
    if (handle && area && isRect(area)) {
      drag = { kind: "resize", id: area.area_id, box: bbox(area) };
      return;
    }
    const hit = areaAt(point);
    if (mode === "route") {
      if (!hit) return;
      if (routeFrom == null) routeFrom = hit.area_id;
      else if (Number(routeFrom) !== Number(hit.area_id)) {
        toggleRoute(routeFrom, hit.area_id);
        routeFrom = null;
      }
      draw();
      return;
    }
    selected = hit ? hit.area_id : null;
    if (hit) drag = { kind: "move", id: hit.area_id, last: point };
    draw();
  });

  board.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = svgPoint(event);
    if (drag.kind === "rect") {
      const box = bbox({ points: [drag.origin, point] });
      const poly = [
        box.minX + "," + box.minY,
        box.maxX + "," + box.minY,
        box.maxX + "," + box.maxY,
        box.minX + "," + box.maxY
      ].join(" ");
      draftG.replaceChildren(el("polygon", { points: poly, class: "area-shape draft" }));
      return;
    }
    const area = byId(drag.id);
    if (!area) return;
    if (drag.kind === "move") {
      const dx = point.x - drag.last.x;
      const dy = point.y - drag.last.y;
      area.points = area.points.map((pt) => ({ x: Math.round((pt.x + dx) * 10) / 10, y: Math.round((pt.y + dy) * 10) / 10 }));
      drag.last = point;
      const pos = nodePos(area.points);
      area.x = pos.x;
      area.y = pos.y;
      draw();
    } else if (drag.kind === "resize") {
      const box = drag.box;
      const maxX = Math.max(box.minX + 12, point.x);
      const maxY = Math.max(box.minY + 12, point.y);
      area.points = [
        { x: box.minX, y: box.minY },
        { x: maxX, y: box.minY },
        { x: maxX, y: maxY },
        { x: box.minX, y: maxY }
      ];
      const pos = nodePos(area.points);
      area.x = pos.x;
      area.y = pos.y;
      draw();
    }
  });

  board.addEventListener("pointerup", (event) => {
    if (drag && drag.kind === "rect") onRect(svgPoint(event));
    drag = null;
    draftG.replaceChildren();
    if (mode === "poly" && draft.length) draw();
  });

  function toggleRoute(a, b) {
    const left = byId(a);
    const right = byId(b);
    if (!left || !right) return;
    const has = (left.routes || []).some((id) => Number(id) === Number(b));
    function without(list, id) {
      return (list || []).filter((item) => Number(item) !== Number(id));
    }
    if (has) {
      left.routes = without(left.routes, b);
      right.routes = without(right.routes, a);
    } else {
      left.routes = without(left.routes, b).concat([Number(b)]);
      right.routes = without(right.routes, a).concat([Number(a)]);
    }
  }

  async function load() {
    await SH.applyNavPermissions();
    if (!SH.isLoggedIn()) {
      document.getElementById("gate").hidden = false;
      document.getElementById("editor").hidden = true;
      return;
    }
    const data = await fetch("/api/map", { credentials: "include", cache: "no-store", headers: { "X-SH-Request": "1" } }).then((res) => res.json());
    image = data.image || null;
    areas = Array.isArray(data.areas) ? data.areas : [];
    draw();
  }

  setMode("select");
  load().catch((err) => {
    msg.textContent = err.message || "Could not load the editor";
  });
})();
