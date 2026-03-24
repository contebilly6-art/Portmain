const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

const STOCK_SYMBOLS = [
  "SPY","QQQ","SOFI","RYCEY","LFMD","NKE","CAKE","TMC","DIA",
  "SOXX","XLK","XLF","XLE","XLV","XLY","XLI","XLRE","XLU","XLB","XLC","XLP"
];

const CRYPTO_IDS = {
  "bitcoin":"BTC","ethereum":"ETH","ripple":"XRP",
  "hedera-hashgraph":"HBAR","stellar":"XLM","ondo-finance":"ONDO","wormhole":"W"
};

let cachedPrices = {};
let lastFetched = 0;
let isRefreshing = false;

async function fetchWithTimeout(url, ms=5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, {signal:ctrl.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

async function getStockQuote(sym) {
  try {
    const r = await fetchWithTimeout(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`, 4000);
    const d = await r.json();
    if(!d || d.c===0) return null;
    const res = { price:d.c, changePct:parseFloat((((d.c-d.pc)/d.pc)*100).toFixed(2)) };
    if(d.ap>0) res.afterHoursPrice=d.ap;
    if(d.pp>0) res.preMarketPrice=d.pp;
    return res;
  } catch(e) { return null; }
}

async function getCrypto() {
  try {
    const ids = Object.keys(CRYPTO_IDS).join(",");
    const r = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, 7000);
    const d = await r.json();
    const res = {};
    for(const [id,sym] of Object.entries(CRYPTO_IDS)) {
      if(d[id]) res[sym] = { price:d[id].usd, changePct:parseFloat((d[id].usd_24h_change||0).toFixed(2)) };
    }
    return res;
  } catch(e) { return {}; }
}

// ✅ VIX from Yahoo Finance — server side so no CORS issues
async function getVIX() {
  try {
    const r = await fetchWithTimeout("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", 6000);
    const d = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    if(!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose || price;
    return { price, changePct:parseFloat((((price-prev)/prev)*100).toFixed(2)) };
  } catch(e) {
    // Fallback: try query2
    try {
      const r = await fetchWithTimeout("https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", 6000);
      const d = await r.json();
      const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if(price) return { price, changePct:0 };
    } catch(e2) {}
    return null;
  }
}

// ✅ Stock chart history — server side so no CORS issues
async function getStockHistory(sym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo`;
    const r = await fetchWithTimeout(url, 8000);
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if(!result?.timestamps?.length) return null;
    const ts = result.timestamps;
    const cl = result.indicators?.quote?.[0]?.close || [];
    const dates=[], closes=[];
    ts.forEach((t,i) => {
      if(cl[i]!=null) {
        dates.push(new Date(t*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"}));
        closes.push(parseFloat(cl[i].toFixed(2)));
      }
    });
    if(!dates.length) return null;
    const meta = result.meta;
    return {
      dates, closes,
      afterHoursPrice: meta?.postMarketPrice>0 ? meta.postMarketPrice : null,
      preMarketPrice: meta?.preMarketPrice>0 ? meta.preMarketPrice : null,
    };
  } catch(e) { return null; }
}

async function refreshPrices() {
  if(isRefreshing) return;
  isRefreshing = true;
  try {
    const [stockEntries, cryptoRes, vixRes] = await Promise.all([
      Promise.all(STOCK_SYMBOLS.map(async sym => [sym, await getStockQuote(sym)])),
      getCrypto(),
      getVIX(),
    ]);
    const prices = {...cryptoRes};
    stockEntries.forEach(([sym,d]) => { if(d) prices[sym]=d; });
    if(vixRes) prices["VIX"] = vixRes;
    if(Object.keys(prices).length > 5) {
      cachedPrices = prices;
      lastFetched = Date.now();
      console.log(`✅ ${Object.keys(prices).length} symbols | VIX:${vixRes?.price||"n/a"}`);
    }
  } catch(e) { console.error(e.message); }
  isRefreshing = false;
}

// ✅ Main prices endpoint
app.get("/api/prices", async (req,res) => {
  if(!FINNHUB_KEY) return res.status(500).json({success:false,error:"FINNHUB_KEY not set"});
  if(Object.keys(cachedPrices).length > 0) {
    res.json({success:true, prices:cachedPrices, updatedAt:new Date(lastFetched).toISOString()});
    if(Date.now()-lastFetched > 15000) refreshPrices();
    return;
  }
  await refreshPrices();
  res.json({success:true, prices:cachedPrices, updatedAt:new Date(lastFetched).toISOString()});
});

// ✅ NEW: Stock chart history endpoint — bypasses browser CORS completely
app.get("/api/history/:symbol", async (req,res) => {
  const sym = req.params.symbol.toUpperCase();
  const data = await getStockHistory(sym);
  if(!data) return res.json({success:false, dates:[], closes:[]});
  res.json({success:true, ...data});
});

app.get("/", (req,res) => res.json({status:"Portfolio API ✅", symbols:Object.keys(cachedPrices).length}));

setInterval(refreshPrices, 15000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Port ${PORT}`);
  if(FINNHUB_KEY) { await refreshPrices(); console.log("Cache ready ✅"); }
});{
  "name": "portfolio-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": { "cors": "^2.8.5", "express": "^4.18.2", "node-fetch": "^2.7.0" }
}
