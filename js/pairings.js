(function () {
  const listEl = document.getElementById("list");
  const msg = document.getElementById("review-msg");
  let entrants = [];
  let rounds = [];
  let pairings = [];
  let slots = [];

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
      if (pairing.kind === "bye") {
        const bye = document.createElement("p");
        bye.textContent = "No table";
        card.appendChild(bye);
      } else if (SH.isLoggedIn()) {
        card.appendChild(tableSelect(pairing));
      } else if (pairing.table) {
        const where = document.createElement("p");
        where.textContent = "Table " + pairing.table + placeText(pairing);
        card.appendChild(where);
      }
      const meta = document.createElement("p");
      const booked = pairing.table && pairings.some((other) => {
        return other.pairing_id !== pairing.pairing_id &&
          String(other.round_id) === String(pairing.round_id) &&
          other.table === pairing.table;
      });
      meta.textContent = [pairing.state, pairing.locked ? "locked" : "", booked ? "Table " + pairing.table + " is booked twice" : ""]
        .filter(Boolean)
        .join(" · ");
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

  function placeText(pairing) {
    const slot = slots.find((item) => item.table === pairing.table);
    if (!slot) return "";
    return " · " + slot.area + (slot.scenario ? " · " + slot.scenario : "");
  }

  function tableSelect(pairing) {
    const label = document.createElement("label");
    label.className = "field";
    label.append(document.createTextNode("Table"));
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Unassigned";
    select.appendChild(blank);
    slots.forEach((slot) => {
      const opt = document.createElement("option");
      opt.value = slot.table;
      opt.textContent = slot.table + " · " + slot.area + (slot.scenario ? " · " + slot.scenario : "");
      if (pairing.table === slot.table) opt.selected = true;
      select.appendChild(opt);
    });
    if (pairing.table && !slots.some((slot) => slot.table === pairing.table)) {
      const extra = document.createElement("option");
      extra.value = pairing.table;
      extra.textContent = pairing.table;
      extra.selected = true;
      select.appendChild(extra);
    }
    select.addEventListener("change", async () => {
      const table = select.value || null;
      const taken = table && pairings.some((other) => {
        return other.pairing_id !== pairing.pairing_id &&
          String(other.round_id) === String(pairing.round_id) &&
          other.table === table;
      });
      if (taken) msg.textContent = "Table " + table + " is already booked.";
      try {
        const saved = await SH.save("pairings", { ...pairing, table });
        const warning = saved.warnings && saved.warnings[0];
        msg.textContent = warning || "Table saved.";
        await load();
      } catch (err) {
        msg.textContent = err.message || "Table was not saved";
        select.value = pairing.table || "";
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
    select.onchange = () => {
      render();
      updatePrintLink();
    };
  }

  function updatePrintLink() {
    const link = document.getElementById("print-round");
    const round = rounds.find((item) => String(item.round_id) === String(selectedRound()));
    const rows = pairings.filter((pairing) => round && String(pairing.round_id) === String(round.round_id));
    const published = rows.length > 0 && rows.every((pairing) => pairing.state === "published");
    if (!link) return;
    if (!round || !published) {
      link.hidden = true;
      return;
    }
    link.hidden = false;
    const base = "/print/round/" + encodeURIComponent(round.number);
    link.href = SH.isLoggedIn() ? base + "/organiser" : base;
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
    const areaRes = await fetch("/api/areas", { cache: "no-store" });
    const areas = areaRes.ok ? await areaRes.json() : [];
    slots = slotsFrom(areas);
    fillRounds();
    render();
    updatePrintLink();
  }

  function slotsFrom(areas) {
    const out = [];
    const seen = new Set();
    areas.slice().sort((a, b) => Number(a.area_id) - Number(b.area_id)).forEach((area) => {
      let names = (area.tables || []).map((table) => String(table).trim()).filter(Boolean);
      if (!names.length && area.scenario) names = [String(area.scenario).trim().slice(0, 16)];
      names.forEach((table) => {
        const label = table.slice(0, 16);
        if (!label || seen.has(label)) return;
        seen.add(label);
        out.push({ table: label, area: area.name, scenario: area.scenario || null });
      });
    });
    return out;
  }

  load().catch((err) => {
    listEl.textContent = err.message || "Could not load pairings";
  });
})();
