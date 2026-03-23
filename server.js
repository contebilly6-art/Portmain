
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

// ✅ Allow requests from any origin so Netlify can talk to this server
app.use(cors({
  origin: "*",
  methods: ["GET"],
}));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

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

app.get("/api/prices", async (req, res) => {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ success: false, error: "FINNHUB_KEY environment variable not set" });
  }
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

    res.json({ success: true, prices, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/", (req, res) => res.json({ status: "Portfolio API is running ✅" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
