/**
 * Read-only area map. The picture and outlines come from the public map.
 * Shading is the latest per-round controller. No player names are drawn.
 */
(function () {
  const board = document.getElementById("board");
  const routesG = document.getElementById("routes");
  const areasG = document.getElementById("areas");
  const labelsG = document.getElementById("labels");
  const empty = document.getElementById("empty-msg");
  const sheet = document.getElementById("sheet");
  const NS = "http://www.w3.org/2000/svg";

  let map = { image: null, areas: [] };

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function centroid(area) {
    const pts = area.points && area.points.length ? area.points : [{ x: area.x || 0, y: area.y || 0 }];
    const x = pts.reduce((sum, point) => sum + Number(point.x), 0) / pts.length;
    const y = pts.reduce((sum, point) => sum + Number(point.y), 0) / pts.length;
    return { x, y };
  }

  function pointsAttr(area) {
    return (area.points || []).map((point) => point.x + "," + point.y).join(" ");
  }

  function byId(id) {
    return map.areas.find((area) => Number(area.area_id) === Number(id));
  }

  function draw() {
    const image = map.image;
    const width = (image && image.width) || 800;
    const height = (image && image.height) || 560;
    board.setAttribute("viewBox", "0 0 " + width + " " + height);
    let picture = board.querySelector("image");
    if (image && image.url) {
      if (!picture) {
        picture = el("image", { x: "0", y: "0" });
        board.insertBefore(picture, routesG);
      }
      picture.setAttribute("href", image.url);
      picture.setAttribute("width", String(width));
      picture.setAttribute("height", String(height));
    } else if (picture) picture.remove();
    routesG.replaceChildren();
    areasG.replaceChildren();
    labelsG.replaceChildren();
    const seen = new Set();
    map.areas.forEach((area) => {
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
        routesG.appendChild(el("line", {
          x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "route-line"
        }));
      });
    });
    const font = Math.max(14, Math.round(width / 42));
    map.areas.forEach((area) => {
      if (!area.points || area.points.length < 3) return;
      const shape = el("polygon", {
        points: pointsAttr(area),
        class: "area-shape " + String(area.controller || "neutral").toLowerCase(),
        "data-id": String(area.area_id)
      });
      areasG.appendChild(shape);
      const at = centroid(area);
      const label = el("text", { x: at.x, y: at.y, class: "area-label", "font-size": String(font) });
      label.textContent = area.name || "Area";
      labelsG.appendChild(label);
    });
    empty.hidden = !!((image && image.url) || map.areas.some((area) => area.points && area.points.length >= 3));
  }

  function show(area) {
    document.getElementById("sheet-title").textContent = area.name || "Area";
    const bits = [];
    const holder = area.controller === "Loyalist" || area.controller === "Traitor" ? area.controller : "Neutral";
    bits.push("Held by " + holder);
    if (area.tables && area.tables.length) bits.push("Tables " + area.tables.join(", "));
    if (area.scenario) bits.push(area.scenario);
    document.getElementById("sheet-body").textContent = bits.join(" · ");
    sheet.hidden = false;
  }

  board.addEventListener("click", (event) => {
    const shape = event.target.closest ? event.target.closest(".area-shape") : null;
    if (!shape) return;
    const area = byId(shape.getAttribute("data-id"));
    if (area) show(area);
  });

  document.getElementById("close-sheet").addEventListener("click", () => {
    sheet.hidden = true;
  });

  fetch("/api/public/map", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      map = data || { image: null, areas: [] };
      if (!Array.isArray(map.areas)) map.areas = [];
      draw();
    })
    .catch(() => {
      empty.hidden = false;
      empty.textContent = "Could not load the map.";
    });
})();
