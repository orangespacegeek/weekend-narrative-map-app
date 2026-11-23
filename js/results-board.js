(function () {
  const listEl = document.getElementById("list");
  const queueEl = document.getElementById("queue");
  const editor = document.getElementById("editor");
  const editMsg = document.getElementById("edit-msg");
  let results = [];
  let pairings = [];
  let players = [];
  let current = null;

  function player(id) {
    return players.find((row) => Number(row.player_id) === Number(id));
  }

  function label(id) {
    const row = player(id);
    if (!row) return "Bye";
    return row.display_name + " · " + row.faction + (row.army ? " · " + row.army : "");
  }

  function pairing(id) {
    return pairings.find((row) => Number(row.pairing_id) === Number(id));
  }

  function title(result) {
    const game = pairing(result.pairing_id);
    if (!game) return "Result " + result.result_id;
    const table = game.table ? "Table " + game.table + " · " : game.kind === "bye" ? "Bye · " : "";
    return table + label(game.loyalist_id) + " vs " + label(game.traitor_id);
  }

  function scoreLine(result) {
    const bits = [result.outcome ? result.outcome.replaceAll("_", " ") : "", result.loyalist_vp + "–" + result.traitor_vp, result.confirmation];
    if (result.note) bits.push(result.note);
    return bits.filter(Boolean).join(" · ");
  }

  function card(result, actions) {
    const article = document.createElement("article");
    article.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = title(result);
    const line = document.createElement("p");
    line.textContent = scoreLine(result);
    article.append(heading, line);
    if (result.confirmation === "disputed" && result.counter_outcome) {
      const other = document.createElement("p");
      other.textContent = "Other report: " + result.counter_outcome.replaceAll("_", " ") + " · " + result.counter_loyalist_vp + "–" + result.counter_traitor_vp;
      article.appendChild(other);
    }
    if (actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Review";
      button.addEventListener("click", () => openEditor(result));
      article.appendChild(button);
    }
    return article;
  }

  function render() {
    const confirmed = results.filter((result) => result.confirmation === "confirmed");
    listEl.replaceChildren();
    if (!confirmed.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No confirmed results yet.";
      listEl.appendChild(empty);
    } else confirmed.forEach((result) => listEl.appendChild(card(result, false)));
    if (!queueEl) return;
    const waiting = results.filter((result) => result.confirmation === "pending" || result.confirmation === "disputed");
    queueEl.replaceChildren();
    if (!waiting.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Nothing is waiting.";
      queueEl.appendChild(empty);
    } else waiting.forEach((result) => queueEl.appendChild(card(result, true)));
  }

  function openEditor(result) {
    current = result;
    editor.hidden = false;
    document.getElementById("editor-title").textContent = title(result);
    document.getElementById("edit-loyal").value = result.loyalist_vp == null ? "" : result.loyalist_vp;
    document.getElementById("edit-traitor").value = result.traitor_vp == null ? "" : result.traitor_vp;
    document.getElementById("edit-note").value = result.note || "";
    editMsg.textContent = "";
  }

  function payload() {
    return {
      ...current,
      loyalist_vp: document.getElementById("edit-loyal").value,
      traitor_vp: document.getElementById("edit-traitor").value,
      note: document.getElementById("edit-note").value,
      outcome: null
    };
  }

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    editMsg.textContent = "Saving…";
    try {
      await SH.save("results", payload());
      editMsg.textContent = "Saved.";
      await load();
    } catch (err) {
      editMsg.textContent = err.message || "Could not save";
    }
  });

  document.getElementById("confirm").addEventListener("click", () => act("confirm", "Confirmed."));
  document.getElementById("reject").addEventListener("click", () => act("reject", "Rejected. It is flagged for you."));

  async function act(action, okText) {
    if (!current) return;
    editMsg.textContent = "Saving…";
    try {
      await SH.save("results", payload());
      await SH.resultAction(current.result_id, action);
      editMsg.textContent = okText;
      editor.hidden = true;
      current = null;
      await load();
    } catch (err) {
      editMsg.textContent = err.message || "Could not update the result";
    }
  }

  async function load() {
    await SH.applyNavPermissions();
    if (SH.isLoggedIn()) {
      results = await SH.adminList("results");
      pairings = await SH.adminList("pairings");
      players = await SH.adminList("players");
    } else {
      results = await (await fetch("/api/results", { cache: "no-store" })).json();
      pairings = await (await fetch("/api/pairings", { cache: "no-store" })).json();
      players = await (await fetch("/api/public/entrants", { cache: "no-store" })).json();
    }
    render();
  }

  load().catch((err) => {
    listEl.textContent = err.message || "Could not load results";
  });
})();
