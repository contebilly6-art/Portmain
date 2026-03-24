const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

const STOCK_SYMBOLS = [
  "SPY", "QQQ", "SOFI", "RYCEY", "LFMD", "NKE", "CAKE", "TMC", "DIA",
  "SOXX", "XLK", "XLF", "XLE", "XLV", "XLY", "XLI", "XLRE", "XLU", "XLB", "XLC", "XLP"
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
const CACHE_DURATION = 20000; // 20 seconds — faster updates

// Fetch with timeout to avoid hanging
async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function getStockQuote(symbol) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`;
    const res = await fetchWithTimeout(url, 4000);
    const data = await res.json();
    if (!data || data.c === 0) return null;
    const price = data.c;
    const prevClose = data.pc;
    const changePct = parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2));
    const result = { price, changePct };
    if (data.ap && data.ap > 0) result.afterHoursPrice = data.ap;
    if (data.pp && data.pp > 0) result.preMarketPrice = data.pp;
    return result;
  } catch (e) {
    return null;
  }
}

async function getCryptoPrices() {
  try {
    const ids = Object.keys(CRYPTO_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetchWithTimeout(url, 6000);
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
    console.error("Crypto error:", e.message);
    return {};
  }
}

async function getVIX() {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB_KEY}`;
    const res = await fetchWithTimeout(url, 4000);
    const data = await res.json();
    if (!data || !data.c || data.c === 0) return null;
    const price = data.c;
    const prevClose = data.pc;
    const changePct = prevClose ? parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2)) : 0;
    return { price, changePct };
  } catch (e) {
    return null;
  }
}

// Fetch stocks in small batches to avoid rate limiting
async function fetchStocksInBatches(symbols, batchSize = 10) {
  const results = {};
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async sym => ({ sym, data: await getStockQuote(sym) }))
    );
    batchResults.forEach(({ sym, data }) => {
      if (data) results[sym] = data;
    });
    // Small delay between batches to respect rate limits
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

async function refreshPrices() {
  console.log("Refreshing prices at", new Date().toISOString());
  try {
    // Run stocks, crypto, and VIX all in parallel
    const [stockResults, cryptoResults, vixResult] = await Promise.all([
      fetchStocksInBatches(STOCK_SYMBOLS),
      getCryptoPrices(),
      getVIX(),
    ]);

    const prices = { ...cryptoResults, ...stockResults };
    if (vixResult) prices["VIX"] = vixResult;

    // Only update cache if we got meaningful data
    if (Object.keys(prices).length > 5) {
      cachedPrices = prices;
      lastFetched = Date.now();
      console.log(`Updated ${Object.keys(prices).length} symbols | VIX: ${vixResult?.price || "n/a"}`);
    }
  } catch (e) {
    console.error("Refresh error:", e.message);
  }
}

app.get("/api/prices", async (req, res) => {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ success: false, error: "FINNHUB_KEY not set" });
  }
  // If cache is stale or empty, refresh now
  if (Date.now() - lastFetched > CACHE_DURATION || Object.keys(cachedPrices).length === 0) {
    await refreshPrices();
  }
  res.json({ success: true, prices: cachedPrices, updatedAt: new Date(lastFetched).toISOString() });
});

app.get("/", (req, res) => res.json({ status: "Portfolio API running ✅", symbols: Object.keys(cachedPrices).length }));

// Background refresh every 20 seconds
setInterval(refreshPrices, CACHE_DURATION);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.FINNHUB_KEY) await refreshPrices();
});
