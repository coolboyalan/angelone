// angelInstruments.util.js
import axios from "axios";
import cron from "node-cron";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Angel scrip master JSON you provided
const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_PATH = path.join(__dirname, "angel_scrip_master_cache.json");

let SCRIP_CACHE = []; // Raw array of Angel rows

export async function loadAngelScripMaster(force = false) {
  try {
    if (!force) {
      // Try cache first
      try {
        const text = await readFile(CACHE_PATH, "utf8");
        SCRIP_CACHE = JSON.parse(text);
        if (Array.isArray(SCRIP_CACHE) && SCRIP_CACHE.length) return true;
      } catch {}
    }
    const res = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    if (!Array.isArray(res.data))
      throw new Error("Unexpected scrip master format");
    SCRIP_CACHE = res.data;
    await writeFile(CACHE_PATH, JSON.stringify(SCRIP_CACHE));
    return true;
  } catch (e) {
    console.error("Failed to load Angel scrip master:", e.message);
    return false;
  }
}

// Refresh daily at 7:05 IST
cron.schedule(
  "5 7 * * *",
  async () => {
    await loadAngelScripMaster(true);
  },
  { timezone: "Asia/Kolkata" },
);

// Helpers

function normalizeIndexBaseName(name) {
  // Normalize base asset names used in your DB to Angel naming for options roots
  // Examples:
  // BANKNIFTY in your DB → Angel option symbols contain "BANKNIFTY"
  // NIFTY in your DB → Angel option symbols contain "NIFTY"
  return String(name || "").toUpperCase();
}

// Angel scrip master fields (examples from your JSON):
// {
//   "token": "2885",
//   "symbol": "RELIANCE-EQ",
//   "name": "RELIANCE",
//   "expiry": "",
//   "strike": "-1.000000",
//   "lotsize": "1",
//   "instrumenttype": "",
//   "exch_seg": "nse_cm",
//   "tick_size": "5.000000"
// }
//
// For F&O options, you'll see instrumenttype "CE"/"PE", exch_seg like "nfo_fo", expiry as "YYYY-MM-DD" (or Angel format), strike > 0, and symbol like "BANKNIFTY25AUG45600CE"
//
// Return an object compatible with your trading code:
// { exchange: "NFO", tradingsymbol: "...", symboltoken: "...", lot_size: <int> }

export function resolveAngelOption(baseName, strike, direction) {
  const base = normalizeIndexBaseName(baseName);
  const typ = String(direction || "").toUpperCase(); // CE/PE
  if (!SCRIP_CACHE.length) return null;

  const fnoRows = SCRIP_CACHE.filter((r) => {
    const seg = String(r.exch_seg || "").toLowerCase();
    const inst = String(r.instrumenttype || "").toUpperCase();
    const nm = String(r.name || "").toUpperCase();
    const sym = String(r.symbol || "").toUpperCase();
    const strikeNum = Number(r.strike);

    if (!seg.includes("nfo")) return false; // options segment
    if (!(inst === "CE" || inst === "PE")) return false;
    if (inst !== typ) return false;

    // Match index family
    if (base === "BANKNIFTY") {
      if (!(nm.includes("BANKNIFTY") || sym.includes("BANKNIFTY")))
        return false;
    } else if (base === "NIFTY") {
      // Exclude BANKNIFTY, FINNIFTY etc. Keep plain NIFTY index options
      if (!(nm === "NIFTY" || sym.startsWith("NIFTY"))) return false;
      if (sym.includes("BANKNIFTY") || sym.includes("FIN")) return false;
    } else {
      // Fallback match by name or symbol containing base
      if (!(nm.includes(base) || sym.includes(base))) return false;
    }

    // Match strike
    return Math.round(Number(strikeNum)) === Math.round(Number(strike));
  });

  if (!fnoRows.length) return null;

  // Pick nearest expiry among matches
  const withExpiry = fnoRows
    .map((r) => {
      // Angel expiry can be "", or "2025-08-28", or other; parse defensively
      const expStr = String(r.expiry || "");
      const expDate = expStr ? new Date(expStr) : null;
      const ts =
        expDate && !isNaN(expDate.getTime())
          ? expDate.getTime()
          : Number.MAX_SAFE_INTEGER;
      return { row: r, ts };
    })
    .sort((a, b) => a.ts - b.ts);

  const chosen = withExpiry[0].row;

  // Map fields to your code expectations
  const exchange = chosen.exch_seg.toUpperCase().startsWith("NFO")
    ? "NFO"
    : "NSE";
  const lot_size = Number(chosen.lotsize) || 1;

  return {
    exchange,
    tradingsymbol: chosen.symbol, // e.g., BANKNIFTY25AUG45600CE
    symboltoken: String(chosen.token),
    lot_size,
  };
}

// LTP request payload helper
export function angelQuotePayloadFromResolved(resolved) {
  return {
    exchange: resolved.exchange === "NFO" ? "NFO" : "NSE",
    tradingsymbol: resolved.tradingsymbol,
    symboltoken: resolved.symboltoken,
  };
}
