const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

// ✅ VIX included in the same batch as all other stocks — no separate slow call
const STOCK_SYMBOLS = [
  "SPY", "QQQ", "SOFI", "RYCEY", "LFMD", "NKE", "CAKE", "TMC",
  "SOXX", "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLRE", "XLU", "XLB", "XLC", "XLP", "DIA"
];

const CRYPTO_IDS = {
  "bitcoin":          "BTC",
  "ethereum":         "ETH",
  "ripple":           "XRP",
  "hedera-hashgraph": "HBAR",
  "stellar":          "XLM",
  "ondo-finance":     "ONDO",
  "wormhole":         "W",
};

let cachedPrices = {};
let lastFetched = 0;
const CACHE_DURATION = 30000;

async function getStockQuote(symbol) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || data.c === 0) return null;
    const price = data.c;
    const prevClose = data.pc;
    const changePct = parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2));
    const result = { price, changePct };
    // Include after hours / pre-market price if available
    if (data.ap && data.ap > 0) result.afterHoursPrice = data.ap;  // after hours
    if (data.pp && data.pp > 0) result.preMarketPrice = data.pp;   // pre-market
    return result;
  } catch (e) {
    console.error(`Error fetching ${symbol}:`, e.message);
    return null;
  }
}

// ✅ VIX fetched directly from Finnhub — same speed as other stocks
async function getVIX() {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data || !data.c || data.c === 0) return null;
    const price = data.c;
    const prevClose = data.pc;
    const changePct = prevClose ? parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2)) : 0;
    return { price, changePct };
  } catch (e) {
    console.error("VIX fetch error:", e.message);
    return null;
  }
}

async function getCryptoPrices() {
  try {
    const ids = Object.keys(CRYPTO_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    const data = await res.json();
    const result = {};
    for (const [cgId, sym] of Object.entries(CRYPTO_IDS)) {
      if (data[cgId]) {
        result[sym] = {
          price: data[cgId].usd,
          changePct: parseFloat((data[cgId].usd_24h_change || 0).toFixed(2)),
        };
      }
    }
    return result;
  } catch (e) {
    console.error("Crypto fetch error:", e.message);
    return {};
  }
}

async function refreshPrices() {
  console.log("Refreshing all prices at", new Date().toISOString());
  try {
    // ✅ All fetched in parallel — VIX, stocks, and crypto all at once
    const stockPromises = STOCK_SYMBOLS.map(async (sym) => {
      const data = await getStockQuote(sym);
      return { sym, data };
    });

    const [stockResults, cryptoResults, vixResult] = await Promise.all([
      Promise.all(stockPromises),
      getCryptoPrices(),
      getVIX(),
    ]);

    const prices = { ...cryptoResults };
    stockResults.forEach(({ sym, data }) => {
      if (data) prices[sym] = data;
    });

    if (vixResult) {
      prices["VIX"] = vixResult;
      console.log("VIX:", vixResult.price);
    }

    cachedPrices = prices;
    lastFetched = Date.now();
    console.log("Refresh complete — total symbols:", Object.keys(prices).length);
  } catch (e) {
    console.error("Refresh error:", e.message);
  }
}

app.get("/api/prices", async (req, res) => {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ success: false, error: "FINNHUB_KEY not set" });
  }
  if (Date.now() - lastFetched > CACHE_DURATION || Object.keys(cachedPrices).length === 0) {
    await refreshPrices();
  }
  res.json({ success: true, prices: cachedPrices, updatedAt: new Date(lastFetched).toISOString() });
});

app.get("/", (req, res) => res.json({ status: "Portfolio API running ✅" }));

setInterval(refreshPrices, CACHE_DURATION);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.FINNHUB_KEY) await refreshPrices();
});
