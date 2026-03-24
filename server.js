const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

process.on("uncaughtException", function(err) { console.error("Uncaught:", err.message); });
process.on("unhandledRejection", function(err) { console.error("Unhandled:", err ? err.message : err); });

const app = express();
app.use(cors({ origin: "*", methods: ["GET"] }));

const FINNHUB_KEY = process.env.FINNHUB_KEY;

const STOCK_SYMBOLS = [
  "SPY","QQQ","SOFI","RYCEY","LFMD","NKE","CAKE","TMC","DIA",
  "SOXX","XLK","XLF","XLE","XLV","XLY","XLI","XLRE","XLU","XLB","XLC","XLP"
];

const CRYPTO_IDS = {
  "bitcoin": "BTC",
  "ethereum": "ETH",
  "ripple": "XRP",
  "hedera-hashgraph": "HBAR",
  "stellar": "XLM",
  "ondo-finance": "ONDO",
  "wormhole": "W"
};

var cachedPrices = {};
var lastFetched = 0;
var isRefreshing = false;

function fetchWithTimeout(url, ms) {
  ms = ms || 5000;
  var ctrl = new AbortController();
  var t = setTimeout(function() { ctrl.abort(); }, ms);
  return fetch(url, { signal: ctrl.signal }).then(function(r) {
    clearTimeout(t);
    return r;
  }).catch(function(e) {
    clearTimeout(t);
    throw e;
  });
}

function getStockQuote(sym) {
  var url = "https://finnhub.io/api/v1/quote?symbol=" + sym + "&token=" + FINNHUB_KEY;
  return fetchWithTimeout(url, 4000).then(function(r) {
    return r.json();
  }).then(function(d) {
    if (!d || d.c === 0) return null;
    var res = {
      price: d.c,
      changePct: parseFloat((((d.c - d.pc) / d.pc) * 100).toFixed(2))
    };
    if (d.ap && d.ap > 0) res.afterHoursPrice = d.ap;
    if (d.pp && d.pp > 0) res.preMarketPrice = d.pp;
    return res;
  }).catch(function() { return null; });
}

function getCrypto() {
  var ids = Object.keys(CRYPTO_IDS).join(",");
  var url = "https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd&include_24hr_change=true";
  return fetchWithTimeout(url, 7000).then(function(r) {
    return r.json();
  }).then(function(d) {
    var res = {};
    Object.keys(CRYPTO_IDS).forEach(function(id) {
      var sym = CRYPTO_IDS[id];
      if (d[id]) {
        res[sym] = {
          price: d[id].usd,
          changePct: parseFloat((d[id].usd_24h_change || 0).toFixed(2))
        };
      }
    });
    return res;
  }).catch(function() { return {}; });
}

function getVIX() {
  return fetchWithTimeout("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", 6000)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var result = d && d.chart && d.chart.result && d.chart.result[0];
      var meta = result && result.meta;
      var price = meta && meta.regularMarketPrice;
      if (!price) return null;
      var prev = (meta.chartPreviousClose || meta.previousClose || price);
      return {
        price: price,
        changePct: parseFloat((((price - prev) / prev) * 100).toFixed(2))
      };
    })
    .catch(function() {
      return fetchWithTimeout("https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", 6000)
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var price = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta && d.chart.result[0].meta.regularMarketPrice;
          if (price) return { price: price, changePct: 0 };
          return null;
        })
        .catch(function() { return null; });
    });
}

function getStockHistory(sym) {
  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?interval=1d&range=1mo";
  return fetchWithTimeout(url, 8000)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var result = d && d.chart && d.chart.result && d.chart.result[0];
      if (!result || !result.timestamps || !result.timestamps.length) return null;
      var ts = result.timestamps;
      var cl = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
      var dates = [];
      var closes = [];
      ts.forEach(function(t, i) {
        if (cl[i] != null) {
          dates.push(new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
          closes.push(parseFloat(cl[i].toFixed(2)));
        }
      });
      if (!dates.length) return null;
      var meta = result.meta;
      return {
        dates: dates,
        closes: closes,
        afterHoursPrice: (meta && meta.postMarketPrice > 0) ? meta.postMarketPrice : null,
        preMarketPrice: (meta && meta.preMarketPrice > 0) ? meta.preMarketPrice : null
      };
    })
    .catch(function() { return null; });
}

function refreshPrices() {
  if (isRefreshing) return Promise.resolve();
  isRefreshing = true;
  var stockPromises = STOCK_SYMBOLS.map(function(sym) {
    return getStockQuote(sym).then(function(d) { return [sym, d]; });
  });
  return Promise.all([
    Promise.all(stockPromises),
    getCrypto(),
    getVIX()
  ]).then(function(results) {
    var stockEntries = results[0];
    var cryptoRes = results[1];
    var vixRes = results[2];
    var prices = {};
    Object.keys(cryptoRes).forEach(function(k) { prices[k] = cryptoRes[k]; });
    stockEntries.forEach(function(entry) {
      if (entry[1]) prices[entry[0]] = entry[1];
    });
    if (vixRes) prices["VIX"] = vixRes;
    if (Object.keys(prices).length > 5) {
      cachedPrices = prices;
      lastFetched = Date.now();
      console.log("Updated " + Object.keys(prices).length + " symbols. VIX: " + (vixRes ? vixRes.price : "n/a"));
    }
    isRefreshing = false;
  }).catch(function(e) {
    console.error("Refresh error:", e.message);
    isRefreshing = false;
  });
}

app.get("/api/prices", function(req, res) {
  if (!FINNHUB_KEY) return res.status(500).json({ success: false, error: "FINNHUB_KEY not set" });
  if (Object.keys(cachedPrices).length > 0) {
    res.json({ success: true, prices: cachedPrices, updatedAt: new Date(lastFetched).toISOString() });
    if (Date.now() - lastFetched > 60000) refreshPrices();
    return;
  }
  refreshPrices().then(function() {
    res.json({ success: true, prices: cachedPrices, updatedAt: new Date(lastFetched).toISOString() });
  });
});

app.get("/api/history/:symbol", function(req, res) {
  var sym = req.params.symbol.toUpperCase();
  getStockHistory(sym).then(function(data) {
    if (!data) return res.json({ success: false, dates: [], closes: [] });
    res.json({ success: true, dates: data.dates, closes: data.closes, afterHoursPrice: data.afterHoursPrice, preMarketPrice: data.preMarketPrice });
  });
});

app.get("/", function(req, res) {
  res.json({ status: "Portfolio API running", symbols: Object.keys(cachedPrices).length });
});

setInterval(refreshPrices, 60000);

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
  if (FINNHUB_KEY) {
    refreshPrices().then(function() {
      console.log("Cache pre-warmed");
    });
  }
});
