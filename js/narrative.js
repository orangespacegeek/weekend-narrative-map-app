(function () {
  const logEl = document.getElementById("log");
  let rounds = [];

  function line(text) {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  }

  function names(player) {
    if (!player) return "Unknown";
    return player.display_name + " · " + player.faction + (player.army ? " · " + player.army : "");
  }

  function render(data) {
    rounds = data.rounds || [];
    logEl.replaceChildren();
    const select = document.getElementById("recap-round");
    if (select) {
      const current = select.value;
      select.replaceChildren();
      rounds.forEach((round) => {
        const opt = document.createElement("option");
        opt.value = String(round.round_id);
        opt.textContent = "Round " + round.number;
        select.appendChild(opt);
      });
      if (current) select.value = current;
      const chosen = rounds.find((round) => String(round.round_id) === select.value);
      document.getElementById("recap-text").value = chosen && chosen.blurb ? chosen.blurb : "";
    }
    if (!rounds.length) {
      logEl.appendChild(line("No published round yet."));
      return;
    }
    rounds.forEach((round) => {
      const card = document.createElement("article");
      card.className = "card";
      const title = document.createElement("h2");
      title.textContent = "Round " + round.number;
      card.appendChild(title);
      if (round.blurb) card.appendChild(line(round.blurb));
      const areas = document.createElement("h3");
      areas.textContent = "Areas";
      card.appendChild(areas);
      (round.areas || []).forEach((area) => {
        const verb = area.controller === area.previous ? "held" : "taken";
        card.appendChild(line(area.name + " " + verb + " by " + (area.controller === "neutral" ? "nobody" : area.controller) + ". " + area.reason + "."));
      });
      if ((round.battles || []).length) {
        const battles = document.createElement("h3");
        battles.textContent = "Apex and Grudge";
        card.appendChild(battles);
        round.battles.forEach((battle) => {
          const where = [battle.kind, battle.table ? "table " + battle.table : "", battle.area].filter(Boolean).join(" · ");
          card.appendChild(line(where + ": " + names(battle.loyalist) + " " + battle.loyalist_vp + " – " + battle.traitor_vp + " " + names(battle.traitor)));
        });
      }
      if ((round.notes || []).length) {
        const notes = document.createElement("h3");
        notes.textContent = "Notes";
        card.appendChild(notes);
        round.notes.forEach((note) => {
          card.appendChild(line(note.display_name + (note.army ? " · " + note.army : "") + ": " + note.note));
        });
      }
      logEl.appendChild(card);
    });
  }

  document.getElementById("recap-round").addEventListener("change", () => {
    const chosen = rounds.find((round) => String(round.round_id) === document.getElementById("recap-round").value);
    document.getElementById("recap-text").value = chosen && chosen.blurb ? chosen.blurb : "";
  });

  document.getElementById("recap").addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = document.getElementById("recap-msg");
    msg.textContent = "Saving…";
    try {
      await SH.saveNarrative(Number(document.getElementById("recap-round").value), document.getElementById("recap-text").value);
      msg.textContent = "Saved.";
      await load();
    } catch (err) {
      msg.textContent = err.message || "Could not save the recap";
    }
  });

  async function load() {
    const res = await fetch("/api/narrative", { cache: "no-store" });
    const data = await res.json();
    render(data);
  }

  load().catch(() => {
    logEl.textContent = "Could not load the log.";
  });
})();
