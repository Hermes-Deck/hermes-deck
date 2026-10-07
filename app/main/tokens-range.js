"use strict";
// relay:tokens. The renderer asks for a Token-pane range ("24h" | "7d" | "14d" | "30d" | "all"); old callers pass
// a day count. A relay that predates ranges ignores ?range= and answers its default 7-day ARRAY: then the range
// is re-asked as ?days=N (24h -> today only, All -> the 400 days it keeps) and returned as {legacy: true, rows}.
const RANGES = ["24h", "7d", "14d", "30d", "all"];
const LEGACY_DAYS = { "24h": 1, "7d": 7, "14d": 14, "30d": 30, all: 400 };
const clampDays = d => Math.min(400, Math.max(1, Math.floor(Number(d)) || 7));

async function fetchTokens(get, arg) {
  if (!RANGES.includes(arg)) return get(`/tokens?days=${clampDays(arg)}`);
  const body = await get(`/tokens?range=${arg}`);
  if (!Array.isArray(body)) return body;
  return { legacy: true, range: arg, rows: arg === "7d" ? body : await get(`/tokens?days=${LEGACY_DAYS[arg]}`) };
}

module.exports = { fetchTokens, RANGES, LEGACY_DAYS };
