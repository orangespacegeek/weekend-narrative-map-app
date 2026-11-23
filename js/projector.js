(function () {
  const NS = "http://www.w3.org/2000/svg";

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function centroid(area) {
    const pts = area.points && area.points.length ? area.points : [{ x: area.x || 0, y: area.y || 0 }];
    return {
      x: pts.reduce((sum, point) => sum + Number(point.x), 0) / pts.length,
      y: pts.reduce((sum, point) => sum + Number(point.y), 0) / pts.length
    };
  }

  function draw(data) {
    const board = document.getElementById("board");
    const width = (data.image && data.image.width) || 800;
    const height = (data.image && data.image.height) || 560;
    board.setAttribute("viewBox", "0 0 " + width + " " + height);
    const routes = document.getElementById("routes");
    const areas = document.getElementById("areas");
    const labels = document.getElementById("labels");
    routes.replaceChildren();
    areas.replaceChildren();
    labels.replaceChildren();
    const byId = new Map((data.areas || []).map((area) => [Number(area.area_id), area]));
    const seen = new Set();
    (data.areas || []).forEach((area) => {
      (area.routes || []).forEach((otherId) => {
        const a = Number(area.area_id);
        const b = Number(otherId);
        const key = a < b ? a + "-" + b : b + "-" + a;
        if (seen.has(key) || !byId.has(b)) return;
        seen.add(key);
        const pa = centroid(area);
        const pb = centroid(byId.get(b));
        routes.appendChild(el("line", { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: "route-line" }));
      });
      if (!area.points || area.points.length < 3) return;
      areas.appendChild(el("polygon", {
        points: area.points.map((point) => point.x + "," + point.y).join(" "),
        class: "area-shape " + String(area.controller || "neutral").toLowerCase()
      }));
      const at = centroid(area);
      const label = el("text", { x: at.x, y: at.y, class: "area-label", "font-size": String(Math.max(16, Math.round(width / 38))) });
      label.textContent = area.name || "";
      labels.appendChild(label);
    });
  }

  function bar(data) {
    const loyal = data.factions.Loyalist.areas;
    const traitor = data.factions.Traitor.areas;
    const open = data.factions.neutral.areas;
    const total = Math.max(1, loyal + traitor + open);
    const elBar = document.getElementById("bar");
    elBar.replaceChildren();
    [
      ["loyal", "Loyalist " + loyal + " · " + data.factions.Loyalist.campaign_points + " CP", loyal],
      ["open", "Contested " + open, open],
      ["traitor", "Traitor " + traitor + " · " + data.factions.Traitor.campaign_points + " CP", traitor]
    ].forEach(([cls, text, count]) => {
      const span = document.createElement("span");
      span.className = cls;
      span.style.flex = String(count || 0.15);
      span.textContent = text;
      elBar.appendChild(span);
    });
    elBar.setAttribute("aria-valuenow", String(total));
  }

  function general(title, row) {
    const card = document.createElement("article");
    const heading = document.createElement("h2");
    heading.textContent = title;
    const name = document.createElement("p");
    name.textContent = row ? row.display_name + (row.army ? " · " + row.army : "") : "—";
    const points = document.createElement("p");
    points.textContent = row ? row.campaign_points + " CP" : "";
    card.append(heading, name, points);
    return card;
  }

  function paint(data) {
    document.getElementById("title").textContent = data.event_name || "Weekend Event";
    const round = data.current_round ? "Round " + data.current_round : "No published round";
    document.getElementById("round").textContent = round + (data.complete ? " · final" : "");
    document.getElementById("leader").textContent = data.leader ? (data.complete ? "Winner: " : "Leader: ") + data.leader : "Tied";
    draw(data);
    bar(data);
    const generals = document.getElementById("generals");
    generals.replaceChildren(general("Loyalist", data.best.loyalist), general("Traitor", data.best.traitor));
    const list = document.getElementById("highlights");
    list.replaceChildren();
    (data.highlights || []).forEach((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      list.appendChild(item);
    });
    if (!list.childElementCount) {
      const item = document.createElement("li");
      item.textContent = "Nothing confirmed yet.";
      list.appendChild(item);
    }
  }

  function load() {
    fetch("/api/projector", { cache: "no-store" })
      .then((res) => res.json())
      .then(paint)
      .catch(() => {
        document.getElementById("round").textContent = "Could not refresh.";
      });
  }

  load();
  setInterval(load, 30000);
})();
