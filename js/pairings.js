(function () {
  const listEl = document.getElementById("list");
  const msg = document.getElementById("review-msg");
  let entrants = [];
  let rounds = [];
  let pairings = [];

  function nameOf(id) {
    const player = entrants.find((row) => Number(row.player_id) === Number(id));
    if (!player) return "Bye";
    return player.display_name + " · " + player.faction + (player.army ? " · " + player.army : "");
  }

  function pairKey(a, b) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? x + ":" + y : y + ":" + x;
  }

  function rematch(loyalistId, traitorId, exceptId) {
    return pairings.some((pairing) => {
      if (Number(pairing.pairing_id) === Number(exceptId)) return false;
      if (!pairing.loyalist_id || !pairing.traitor_id || pairing.kind === "bye") return false;
      return pairKey(pairing.loyalist_id, pairing.traitor_id) === pairKey(loyalistId, traitorId);
    });
  }

  function selectedRound() {
    return document.getElementById("round-select").value;
  }

  function render() {
    const roundId = selectedRound();
    const rows = pairings.filter((pairing) => !roundId || String(pairing.round_id) === String(roundId));
    listEl.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = SH.isLoggedIn() ? "No draft for this round yet." : "Pairings are not published yet.";
      listEl.appendChild(empty);
      return;
    }
    rows.forEach((pairing) => {
      const card = document.createElement("article");
      card.className = "card";
      const title = document.createElement("h2");
      const round = rounds.find((item) => Number(item.round_id) === Number(pairing.round_id));
      title.textContent = (round ? "Round " + round.number + " · " : "") + (pairing.kind === "bye" ? "Bye" : pairing.kind);
      card.appendChild(title);
      if (SH.isLoggedIn() && pairing.state !== "published" && pairing.kind !== "bye") {
        card.append(seatSelect(pairing, "loyalist_id", "Loyalist"), seatSelect(pairing, "traitor_id", "Traitor"));
      } else {
        const line = document.createElement("p");
        if (pairing.kind === "bye") line.textContent = nameOf(pairing.loyalist_id || pairing.traitor_id) + " · bye";
        else line.textContent = nameOf(pairing.loyalist_id) + " vs " + nameOf(pairing.traitor_id);
        card.appendChild(line);
      }
      const meta = document.createElement("p");
      meta.textContent = [pairing.state, pairing.locked ? "locked" : ""].filter(Boolean).join(" · ");
      card.appendChild(meta);
      listEl.appendChild(card);
    });
  }

  function seatSelect(pairing, key, faction) {
    const label = document.createElement("label");
    label.className = "field";
    label.append(document.createTextNode(faction));
    const select = document.createElement("select");
    entrants.filter((player) => player.faction === faction && !player.dropped).forEach((player) => {
      const opt = document.createElement("option");
      opt.value = String(player.player_id);
      opt.textContent = player.display_name + (player.army ? " · " + player.army : "");
      if (Number(player.player_id) === Number(pairing[key])) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", async () => {
      const next = { ...pairing, [key]: Number(select.value) };
      const other = key === "loyalist_id" ? next.traitor_id : next.loyalist_id;
      if (next.loyalist_id && next.traitor_id && rematch(next.loyalist_id, next.traitor_id, pairing.pairing_id)) {
        msg.textContent = "That pair has already played. The swap was not saved.";
        select.value = String(pairing[key]);
        return;
      }
      if (!other) return;
      try {
        await SH.save("pairings", next);
        msg.textContent = "Swap saved.";
        await load();
      } catch (err) {
        msg.textContent = err.message || "Swap rejected";
        select.value = String(pairing[key]);
      }
    });
    label.appendChild(select);
    return label;
  }

  function fillRounds() {
    const select = document.getElementById("round-select");
    if (!select) return;
    const current = select.value;
    select.replaceChildren();
    rounds.forEach((round) => {
      const opt = document.createElement("option");
      opt.value = String(round.round_id);
      opt.textContent = "Round " + round.number;
      select.appendChild(opt);
    });
    if (current) select.value = current;
    select.onchange = render;
  }

  document.getElementById("generate").addEventListener("click", async () => {
    msg.textContent = "Pairing…";
    try {
      let roundId = selectedRound();
      if (!roundId) {
        const created = await SH.save("rounds", { number: 1, state: "draft" });
        roundId = created.round_id;
      }
      const seed = document.getElementById("seed").value;
      const result = await SH.generateRound(roundId, seed === "" ? null : Number(seed));
      msg.textContent = (result.warnings && result.warnings[0]) || "Draft ready. Approve it before it goes public.";
      await load();
    } catch (err) {
      msg.textContent = err.message || "Could not pair the round";
    }
  });

  document.getElementById("approve").addEventListener("click", () => changeState("approve", "Approved. You can publish now."));
  document.getElementById("publish").addEventListener("click", () => changeState("publish", "Published."));

  async function changeState(action, okText) {
    msg.textContent = "Saving…";
    try {
      await SH.roundAction(selectedRound(), action);
      msg.textContent = okText;
      await load();
    } catch (err) {
      msg.textContent = err.message || "Could not update the round";
    }
  }

  async function load() {
    await SH.applyNavPermissions();
    if (SH.isLoggedIn()) {
      entrants = await SH.adminList("players");
      rounds = await SH.adminList("rounds");
      pairings = await SH.adminList("pairings");
    } else {
      entrants = await (await fetch("/api/public/entrants", { cache: "no-store" })).json();
      rounds = await (await fetch("/api/rounds", { cache: "no-store" })).json();
      pairings = await (await fetch("/api/pairings", { cache: "no-store" })).json();
    }
    fillRounds();
    render();
  }

  load().catch((err) => {
    listEl.textContent = err.message || "Could not load pairings";
  });
})();
