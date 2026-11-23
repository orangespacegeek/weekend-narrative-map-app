(function () {
  const KEY = "wem_theme";

  function chosen() {
    try {
      return localStorage.getItem(KEY) || "site";
    } catch (_) {
      return "site";
    }
  }

  function apply(theme) {
    if (theme === "journal-tactica") document.documentElement.setAttribute("data-theme", "journal-tactica");
    else document.documentElement.removeAttribute("data-theme");
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
