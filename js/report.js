(function () {
  const params = new URLSearchParams(location.search);
  const eventCode = params.get("event") || "";
  const roundNumber = params.get("round") || "";
  if (params.has("event")) {
    params.delete("event");
    const query = params.toString();
    history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  }

  const note = document.getElementById("note");
  const form = document.getElementById("report");
  const msg = document.getElementById("msg");
  let games = [];
  let pairingId = null;
  let seat = "";
  let winner = "";

  function person(player) {
    if (!player) return "Open seat";
    return player.display_name + " · " + player.faction + (player.army ? " · " + player.army : "");
  }

  function press(buttons, value, attr) {
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", button.getAttribute(attr) === value ? "true" : "false");
    });
  }

  function showScores() {
    document.getElementById("score-card").hidden = !pairingId || !seat;
  }

  function render(list) {
    games = list;
    const tables = document.getElementById("tables");
    tables.replaceChildren();
    if (!list.length) {
      tables.textContent = "No tables are published for this round.";
      return;
    }
    list.forEach((game) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.setAttribute("data-pairing", String(game.pairing_id));
      const place = [game.area, game.scenario].filter(Boolean).join(" · ");
      button.textContent = "Table " + game.table + (place ? " · " + place : "") + " · " + person(game.loyalist) + " vs " + person(game.traitor);
      button.addEventListener("click", () => chooseTable(game.pairing_id));
      tables.appendChild(button);
    });
  }

  function chooseTable(id) {
    pairingId = id;
    seat = "";
    press(document.querySelectorAll("#tables .choice"), String(id), "data-pairing");
    const game = games.find((row) => Number(row.pairing_id) === Number(id));
    const seats = document.getElementById("seats");
    seats.replaceChildren();
    [["loyalist", game.loyalist], ["traitor", game.traitor]].forEach(([key, player]) => {
      if (!player) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.setAttribute("data-seat", key);
      button.textContent = person(player);
      button.addEventListener("click", () => {
        seat = key;
        press(seats.querySelectorAll(".choice"), key, "data-seat");
        showScores();
      });
      seats.appendChild(button);
    });
    document.getElementById("seat-card").hidden = false;
    showScores();
  }

  document.getElementById("winner").addEventListener("click", (event) => {
    const button = event.target.closest("[data-winner]");
    if (!button) return;
    winner = button.getAttribute("data-winner");
    press(document.querySelectorAll("#winner .choice"), winner, "data-winner");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    msg.textContent = "Sending…";
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-SH-Request": "1" },
        body: JSON.stringify({
          event_code: eventCode,
          round: Number(roundNumber),
          pairing_id: pairingId,
          seat,
          outcome: winner,
          loyalist_vp: document.getElementById("loyalist-vp").value,
          traitor_vp: document.getElementById("traitor-vp").value,
          note: document.getElementById("note-text").value
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The report was not saved");
      if (data.status === "confirmed") msg.textContent = "Both reports match. The result is confirmed.";
      else if (data.status === "disputed") msg.textContent = "The reports do not match. The organiser will sort it out.";
      else msg.textContent = "Report sent. It stays pending until the other player agrees.";
      form.querySelector("button[type=submit]").disabled = true;
    } catch (err) {
      msg.textContent = err.message || "The report was not saved";
    }
  });

  async function load() {
    if (!/^\d+$/.test(roundNumber) || !eventCode) {
      note.textContent = "Open this page from the round QR code.";
      return;
    }
    note.textContent = "Round " + roundNumber + ". Pick your table, then your name.";
    const res = await fetch("/api/report?round=" + encodeURIComponent(roundNumber), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      note.textContent = data.error || "This round is not ready for reports.";
      return;
    }
    form.hidden = false;
    render(data.games || []);
  }

  load();
})();
