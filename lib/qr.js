/**
 * Round QR codes. The picture is built locally from the vendored generator.
 * Nothing is fetched from a QR web service.
 */
"use strict";

const qrcode = require("./vendor/qrcode-generator");

function resultsFormUrl(origin, eventCode, roundNumber) {
  const base = String(origin || "").replace(/\/$/, "");
  const url = new URL("/report.html", base + "/");
  url.searchParams.set("event", String(eventCode || ""));
  url.searchParams.set("round", String(roundNumber));
  return url.toString();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let rects = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      rects += '<rect x="' + (col + quiet) + '" y="' + (row + quiet) + '" width="1" height="1"/>';
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges" role="img">' +
    "<title>Results form</title>" +
    "<desc>" + escapeXml(text) + "</desc>" +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    '<g fill="#000000">' + rects + "</g>" +
    "</svg>"
  );
}

module.exports = { resultsFormUrl, qrSvg };
