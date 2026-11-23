/**
 * Paper pages. No site navigation. Letter and A4 both use the printer margin.
 */
"use strict";

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function placeLabel(row) {
  const parts = [];
  if (row.area) parts.push(row.area);
  if (row.scenario && row.scenario !== row.area && row.scenario !== row.table) parts.push(row.scenario);
  return parts.join(" · ") || "";
}

function playerLine(player) {
  if (!player) return "";
  return [player.display_name, player.faction, player.army].filter(Boolean).join(" · ");
}

const CSS = [
  "@page { margin: 12mm; }",
  "html, body { margin: 0; background: #fff; color: #161616; }",
  "body { font: 11pt Georgia, 'Times New Roman', serif; padding: 12mm; }",
  "header { display: flex; justify-content: space-between; gap: 8mm; align-items: flex-start; }",
  "h1 { font-size: 18pt; margin: 0 0 2mm; }",
  "h2 { font-size: 13pt; margin: 8mm 0 2mm; break-after: avoid; }",
  "p { margin: 0; }",
  ".qr { width: 38mm; height: 38mm; }",
  ".qr svg { width: 100%; height: 100%; }",
  "table { width: 100%; border-collapse: collapse; }",
  "th, td { text-align: left; vertical-align: top; padding: 1.5mm 2mm; border-bottom: 0.2mm solid #bbb; }",
  "th { font-size: 9pt; letter-spacing: 0.04em; text-transform: uppercase; }",
  "tr, .card { break-inside: avoid; }",
  ".warn { margin-top: 3mm; font-style: italic; }",
  ".grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }",
  ".card { border: 0.3mm solid #ccc; padding: 4mm; text-align: center; }",
  ".card .qr { width: 48mm; height: 48mm; margin: 0 auto 3mm; }",
  "@media print { body { padding: 0; } a { color: inherit; text-decoration: none; } }"
].join("\n");

function page(title, body) {
  return (
    "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + esc(title) + "</title><style>" + CSS + "</style></head><body>" +
    body +
    "</body></html>"
  );
}

function renderRoundPage(sheet, qrMarkup) {
  const games = sheet.by_table
    .map((row) => {
      return (
        "<tr><td>" + esc(row.table || "—") + "</td><td>" + esc(placeLabel(row)) + "</td><td>" +
        esc(playerLine(row.loyalist)) + "</td><td>" + esc(playerLine(row.traitor)) + "</td></tr>"
      );
    })
    .join("");
  const players = sheet.by_player
    .map((row) => {
      const against = row.bye ? "Bye" : playerLine(row.opponent);
      return (
        "<tr><td>" + esc(playerLine(row)) + "</td><td>" + esc(row.table || "—") + "</td><td>" +
        esc(placeLabel(row)) + "</td><td>" + esc(against) + "</td></tr>"
      );
    })
    .join("");
  const byes = sheet.byes.length
    ? "<h2>Byes</h2><ul>" + sheet.byes.map((row) => "<li>" + esc(playerLine(row)) + "</li>").join("") + "</ul>"
    : "";
  const warnings = (sheet.warnings || []).map((line) => "<p class=\"warn\">" + esc(line) + "</p>").join("");
  const qrBlock = qrMarkup ? "<div class=\"qr\">" + qrMarkup + "</div>" : "";
  const body =
    "<header><div><h1>" + esc(sheet.event_name) + "</h1><p>Round " + esc(sheet.round.number) + " pairings</p></div>" +
    qrBlock + "</header>" +
    warnings +
    "<h2>By table</h2><table><thead><tr><th>Table</th><th>Area</th><th>Loyalist</th><th>Traitor</th></tr></thead><tbody>" +
    games + "</tbody></table>" +
    "<h2>By player</h2><table><thead><tr><th>Player</th><th>Table</th><th>Area</th><th>Opponent</th></tr></thead><tbody>" +
    players + "</tbody></table>" +
    byes;
  return page(sheet.event_name + " round " + sheet.round.number, body);
}

function renderQrSheet(eventName, cards) {
  const items = cards
    .map((card) => {
      return (
        "<article class=\"card\"><div class=\"qr\">" + card.svg + "</div><h2>Round " + esc(card.number) + "</h2>" +
        "<p><a href=\"/api/rounds/" + esc(card.round_id) + "/qr.svg?download=1\">Download SVG</a></p></article>"
      );
    })
    .join("");
  const body =
    "<h1>" + esc(eventName) + "</h1><p>Each code opens that round's phone results page.</p>" +
    "<div class=\"grid\">" + (items || "<p>No rounds yet.</p>") + "</div>";
  return page(eventName + " QR sheet", body);
}

module.exports = { renderRoundPage, renderQrSheet };
