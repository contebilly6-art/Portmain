const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

// VIX uses ^VIX on Yahoo Finance — fetch separately
const STOCK_SYMBOLS = [
  "SPY", "QQQ", "SOFI", "RYCEY", "LFMD", "NKE", "CAKE", "TMC",
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
    return { price, changePct };
  } catch (e) {
    console.error(`Error fetching ${symbol}:`, e.message);
    return null;
  }
}

// Fetch VIX from Yahoo Finance (free, no key needed)
async function getVIX() {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const changePct = prevClose ? parseFloat((((price - prevClose) / prevClose) * 100).toFixed(2)) : 0;
    return { price, changePct };
  } catch (e) {
    console.error("Error fetching VIX:", e.message);
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
    console.error("Error fetching crypto:", e.message);
    return {};
  }
}

async function refreshPrices() {
  console.log("Refreshing prices at", new Date().toISOString());
  try {
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

    // Add VIX separately
    if (vixResult) prices["VIX"] = vixResult;

    cachedPrices = prices;
    lastFetched = Date.now();
    console.log("VIX:", vixResult?.price, "| Prices updated OK");
  } catch (e) {
    console.error("Error refreshing:", e.message);
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
  console.log(`Server on port ${PORT}`);
  if (process.env.FINNHUB_KEY) await refreshPrices();
});
