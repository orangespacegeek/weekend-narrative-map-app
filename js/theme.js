(function () {
  const KEY = "wem_theme";

  function chosen() {
    try {
      return localStorage.getItem(KEY) || "site";
    } catch (_) {
      return "site";
    }
  }

  function syncFonts(active) {
    let link = document.getElementById("journal-fonts");
    if (!active) {
      if (link) link.remove();
      return;
    }
    if (link) return;
    link = document.createElement("link");
    link.id = "journal-fonts";
    link.rel = "stylesheet";
    link.href = "css/journal-fonts.css";
    document.head.appendChild(link);
  }

  function apply(theme) {
    const active = theme === "journal-tactica";
    if (active) document.documentElement.setAttribute("data-theme", "journal-tactica");
    else document.documentElement.removeAttribute("data-theme");
    syncFonts(active);
  }

  function resolve(choice) {
    const site = document.documentElement.getAttribute("data-site-theme") || "current";
    return choice === "site" ? site : choice;
  }

  function mount() {
    const end = document.querySelector(".header-end");
    if (!end || document.getElementById("theme-choice")) return;
    const label = document.createElement("label");
    label.className = "theme-switch";
    label.innerHTML = '<span class="visually-hidden">Style</span><select id="theme-choice" aria-label="Style"><option value="current">Current</option><option value="journal-tactica">Journal Tactica</option><option value="site">Use site default</option></select>';
    end.insertBefore(label, end.firstChild);
    const select = label.querySelector("select");
    select.value = chosen();
    select.addEventListener("change", () => {
      try { localStorage.setItem(KEY, select.value); } catch (_) {}
      apply(resolve(select.value));
    });
  }

  apply(resolve(chosen()));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
