"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

test("Journal Tactica fonts load only while that theme is active", () => {
  const themeCss = fs.readFileSync(path.join(ROOT, "css", "journal-tactica.css"), "utf8");
  const fonts = fs.readFileSync(path.join(ROOT, "css", "journal-fonts.css"), "utf8");
  const script = fs.readFileSync(path.join(ROOT, "js", "theme.js"), "utf8");
  assert.equal(themeCss.includes("@import"), false);
  assert.equal(themeCss.includes("fonts.googleapis"), false);
  assert.match(fonts, /fonts\.googleapis\.com/);
  assert.match(script, /journal-fonts\.css/);
  assert.ok(script.indexOf('theme === "journal-tactica"') < script.indexOf("journal-fonts.css") || script.includes("syncFonts"));
  const pages = fs.readdirSync(ROOT).filter((name) => name.endsWith(".html"));
  pages.forEach((name) => {
    const html = fs.readFileSync(path.join(ROOT, name), "utf8");
    assert.equal(html.includes("journal-fonts.css"), false, name);
  });
  const active = script.slice(script.indexOf("function syncFonts"));
  assert.match(active, /if \(!active\)/);
  assert.match(active, /journal-fonts\.css/);
  const projector = fs.readFileSync(path.join(ROOT, "projector.html"), "utf8");
  assert.match(projector, /js\/theme\.js/);
  assert.ok(projector.indexOf("js/theme.js") < projector.indexOf("js/projector.js"));
  assert.equal(projector.includes("journal-fonts.css"), false);
});
