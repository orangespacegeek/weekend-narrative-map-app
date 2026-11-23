(function () {
  const listEl = document.getElementById("list");
  const form = document.getElementById("entrant-form");
  const formMsg = document.getElementById("form-msg");
  let entrants = [];
  let rounds = [];
  let pairings = [];
  let editing = null;

  function card(player) {
    const article = document.createElement("article");
    article.className = "card";
    const title = document.createElement("h2");
    title.textContent = player.display_name;
    const detail = document.createElement("p");
    const bits = [player.faction];
    if (player.army) bits.push(player.army);
    if (player.dropped) bits.push("Dropped");
    detail.textContent = bits.join(" · ");
    article.append(title, detail);
    if (SH.isLoggedIn()) {
      const row = document.createElement("div");
      row.className = "button-row";
      row.style.marginTop = "0.6rem";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEdit(player));
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "ghost";
      drop.textContent = player.dropped ? "Restore" : "Drop";
      drop.addEventListener("click", () => toggleDrop(player));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeEntrant(player));
      row.append(edit, drop, remove);
      article.appendChild(row);
    }
    return article;
  }

  function render() {
    listEl.replaceChildren();
    const rows = entrants.slice().sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No entrants yet.";
      listEl.appendChild(empty);
      return;
    }
    rows.forEach((player) => listEl.appendChild(card(player)));
    fillSelects();
    renderSpecial();
  }

  function fillSelects() {
    const roundSelect = document.getElementById("round-select");
    const loyal = document.getElementById("loyal-select");
    const traitor = document.getElementById("traitor-select");
    if (!roundSelect) return;
    roundSelect.replaceChildren();
    rounds.forEach((round) => {
      const opt = document.createElement("option");
      opt.value = String(round.round_id);
      opt.textContent = "Round " + round.number;
      roundSelect.appendChild(opt);
    });
    if (!rounds.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Round 1 will be created";
      roundSelect.appendChild(opt);
    }
    function fill(select, faction) {
      select.replaceChildren();
      entrants.filter((player) => player.faction === faction && !player.dropped).forEach((player) => {
        const opt = document.createElement("option");
        opt.value = String(player.player_id);
        opt.textContent = player.display_name + (player.army ? " · " + player.army : "");
        select.appendChild(opt);
      });
    }
    fill(loyal, "Loyalist");
    fill(traitor, "Traitor");
  }

  function renderSpecial() {
    const box = document.getElementById("special-list");
    if (!box) return;
    box.replaceChildren();
    const locked = pairings.filter((pairing) => pairing.kind === "apex" || pairing.kind === "grudge");
    locked.forEach((pairing) => {
      const row = document.createElement("p");
      const loyalist = entrants.find((player) => Number(player.player_id) === Number(pairing.loyalist_id));
      const traitor = entrants.find((player) => Number(player.player_id) === Number(pairing.traitor_id));
      const round = rounds.find((item) => Number(item.round_id) === Number(pairing.round_id));
      row.textContent = (round ? "Round " + round.number : "Round") + " · " + pairing.kind + " · " +
        (loyalist ? loyalist.display_name : "Loyalist") + " vs " + (traitor ? traitor.display_name : "Traitor") + " · locked";
      box.appendChild(row);
    });
  }

  function startEdit(player) {
    editing = player.player_id;
    form.display_name.value = player.display_name;
    form.faction.value = player.faction;
    form.army.value = player.army || "";
    form.dropped.checked = !!player.dropped;
    document.getElementById("form-title").textContent = "Edit entrant";
    document.getElementById("save-entrant").textContent = "Save";
    document.getElementById("cancel-edit").hidden = false;
    form.scrollIntoView({ block: "nearest" });
  }

  document.getElementById("cancel-edit").addEventListener("click", () => {
    editing = null;
    form.reset();
    document.getElementById("form-title").textContent = "Add entrant";
    document.getElementById("save-entrant").textContent = "Add";
    document.getElementById("cancel-edit").hidden = true;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formMsg.textContent = "Saving…";
    const body = {
      display_name: form.display_name.value,
      faction: form.faction.value,
      army: form.army.value,
      dropped: form.dropped.checked
    };
    try {
      if (editing == null) await SH.save("players", body);
      else await SH.save("players", { ...body, player_id: editing });
      form.reset();
      editing = null;
      document.getElementById("form-title").textContent = "Add entrant";
      document.getElementById("save-entrant").textContent = "Add";
      document.getElementById("cancel-edit").hidden = true;
      formMsg.textContent = "Saved.";
      await load();
    } catch (err) {
      formMsg.textContent = err.message || "Could not save";
    }
  });

  async function toggleDrop(player) {
    await SH.save("players", { ...player, dropped: !player.dropped });
    await load();
  }

  async function removeEntrant(player) {
    if (!confirm("Remove " + player.display_name + "?")) return;
    try {
      await SH.remove("players", player.player_id);
      await load();
    } catch (err) {
      alert(err.message || "Could not remove");
    }
  }

  document.getElementById("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = document.getElementById("import-msg");
    note.textContent = "Importing…";
    try {
      const result = await SH.importRoster(document.getElementById("import-form").text.value);
      note.textContent = "Added " + (result.added || []).length + ".";
      document.getElementById("import-form").reset();
      await load();
    } catch (err) {
      note.textContent = err.message || "Could not import";
    }
  });

  document.getElementById("special-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = document.getElementById("special-msg");
    note.textContent = "Saving match…";
    try {
      let roundId = document.getElementById("round-select").value;
      if (!roundId) {
        const created = await SH.save("rounds", { number: rounds.length + 1, state: "draft" });
        roundId = created.round_id;
      }
      await SH.save("pairings", {
        round_id: Number(roundId),
        kind: document.getElementById("special-form").kind.value,
        state: "draft",
        loyalist_id: Number(document.getElementById("loyal-select").value),
        traitor_id: Number(document.getElementById("traitor-select").value)
      });
      note.textContent = "Locked.";
      await load();
    } catch (err) {
      note.textContent = err.message || "Could not lock the match";
    }
  });

  async function load() {
    await SH.applyNavPermissions();
    if (SH.isLoggedIn()) {
      const [players, roundRows, pairingRows] = await Promise.all([
        SH.adminList("players"),
        SH.adminList("rounds"),
        SH.adminList("pairings")
      ]);
      entrants = players;
      rounds = roundRows;
      pairings = pairingRows;
    } else {
      const res = await fetch("/api/public/entrants", { cache: "no-store" });
      entrants = await res.json();
    }
    render();
  }

  load().catch((err) => {
    listEl.textContent = err.message || "Could not load the roster";
  });
})();
