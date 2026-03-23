const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

const STOCK_SYMBOLS = [
  "SPY", "QQQ", "SOFI", "RYCEY", "LFMD", "NKE", "CAKE", "TMC", "VIX",
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

// Cache prices in memory
let cachedPrices = {};
let lastFetched = 0;
const CACHE_DURATION = 30000; // 30 seconds

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
  console.log("Fetching fresh prices at", new Date().toISOString());
  try {
    const stockPromises = STOCK_SYMBOLS.map(async (sym) => {
      const data = await getStockQuote(sym);
      return { sym, data };
    });

    const [stockResults, cryptoResults] = await Promise.all([
      Promise.all(stockPromises),
      getCryptoPrices(),
    ]);

    const prices = { ...cryptoResults };
    stockResults.forEach(({ sym, data }) => {
      if (data) prices[sym] = data;
    });

    cachedPrices = prices;
    lastFetched = Date.now();
  } catch (e) {
    console.error("Error refreshing prices:", e.message);
  }
}

app.get("/api/prices", async (req, res) => {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ success: false, error: "FINNHUB_KEY environment variable not set" });
  }
  if (Date.now() - lastFetched > CACHE_DURATION || Object.keys(cachedPrices).length === 0) {
    await refreshPrices();
  }
  res.json({ success: true, prices: cachedPrices, updatedAt: new Date(lastFetched).toISOString() });
});

app.get("/", (req, res) => res.json({ status: "Portfolio API is running ✅" }));

setInterval(refreshPrices, CACHE_DURATION);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.FINNHUB_KEY) await refreshPrices();
});
