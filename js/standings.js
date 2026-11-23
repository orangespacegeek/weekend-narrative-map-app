(function () {
  function record(row) {
    return row.wins + "-" + row.losses + "-" + row.ties;
  }

  function signed(value) {
    const number = Number(value) || 0;
    return number > 0 ? "+" + number : String(number);
  }

  function factionCard(name, row) {
    const card = document.createElement("article");
    card.className = "stat";
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = String(row.areas);
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = name + " areas · " + row.campaign_points + " CP";
    card.append(num, label);
    return card;
  }

  function playerCard(row) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h2");
    title.textContent = row.rank + ". " + row.display_name + (row.army ? " · " + row.army : "");
    const line = document.createElement("p");
    line.textContent = record(row) + " · " + row.campaign_points + " CP · VP " + signed(row.vp_diff) + " · SoS " + row.strength_of_schedule;
    card.append(title, line);
    return card;
  }

  function fill(id, rows) {
    const el = document.getElementById(id);
    el.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No players yet.";
      el.appendChild(empty);
      return;
    }
    rows.forEach((row) => el.appendChild(playerCard(row)));
  }

  fetch("/api/standings", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      const title = data.complete ? "Winner" : "Leader";
      document.getElementById("leader").textContent = data.leader ? title + ": " + data.leader : title + ": tied";
      const board = document.getElementById("factions");
      board.replaceChildren(
        factionCard("Loyalist", data.factions.Loyalist),
        factionCard("Traitor", data.factions.Traitor)
      );
      fill("loyalists", data.loyalists || []);
      fill("traitors", data.traitors || []);
    })
    .catch(() => {
      document.getElementById("leader").textContent = "Could not load standings.";
    });
})();
