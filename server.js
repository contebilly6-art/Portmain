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

const CRYPTO_FINNHUB = {
  "BTC": "BINANCE:BTCUSDT",
  "ETH": "BINANCE:ETHUSDT",
  "XRP": "BINANCE:XRPUSDT",
  "HBAR": "BINANCE:HBARUSDT",
  "XLM": "BINANCE:XLMUSDT",
  "ONDO": "BINANCE:ONDOUSDT",
  "W": "BINANCE:WUSDT"
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

// Fetch annual dividend for a stock symbol
function getStockDividend(sym) {
  var url = "https://finnhub.io/api/v1/stock/metric?symbol=" + sym + "&metric=all&token=" + FINNHUB_KEY;
  return fetchWithTimeout(url, 4000).then(function(r) {
    return r.json();
  }).then(function(d) {
    if (!d || !d.metric) return null;
    var annual = d.metric["dividendPerShareAnnual"] || d.metric["currentDividendYieldTTM"] || null;
    var yieldPct = d.metric["dividendYieldIndicatedAnnual"] || null;
    if (!annual && !yieldPct) return null;
    return {
      annual: annual ? parseFloat(annual.toFixed(2)) : null,
      yieldPct: yieldPct ? parseFloat(yieldPct.toFixed(2)) : null
    };
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
      return { price: price, changePct: parseFloat((((price - prev) / prev) * 100).toFixed(2)) };
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

// ✅ Stock chart history via Finnhub candles — no Yahoo blocking issues
function getStockHistory(sym) {
  // Get Unix timestamps for past 30 days
  var now = Math.floor(Date.now() / 1000);
  var from = now - (185 * 24 * 60 * 60); // 35 days back
  var url = "https://finnhub.io/api/v1/stock/candle?symbol=" + sym + "&resolution=D&from=" + from + "&to=" + now + "&token=" + FINNHUB_KEY;

  return fetchWithTimeout(url, 8000).then(function(r) {
    return r.json();
  }).then(function(d) {
    if (!d || d.s !== "ok" || !d.t || !d.t.length) return null;
    var dates = [];
    var closes = [];
    d.t.forEach(function(ts, i) {
      if (d.c[i] != null) {
        var dt = new Date(ts * 1000);
        dates.push(dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
        closes.push(parseFloat(d.c[i].toFixed(2)));
      }
    });
    if (!dates.length) return null;
    return { dates: dates, closes: closes, afterHoursPrice: null, preMarketPrice: null };
  }).catch(function() { return null; });
}

// ✅ Crypto chart history via CoinGecko
function getCryptoHistory(cgId) {
  var url = "https://api.coingecko.com/api/v3/coins/" + cgId + "/market_chart?vs_currency=usd&days=180&interval=daily";
  return fetchWithTimeout(url, 8000).then(function(r) {
    return r.json();
  }).then(function(d) {
    if (!d || !d.prices || !d.prices.length) return null;
    var dates = [];
    var closes = [];
    d.prices.forEach(function(p) {
      var dt = new Date(p[0]);
      dates.push(dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
      closes.push(parseFloat(p[1].toFixed(6)));
    });
    return { dates: dates, closes: closes };
  }).catch(function() { return null; });
}

function refreshPrices() {
  if (isRefreshing) return Promise.resolve();
  isRefreshing = true;
  var stockPromises = STOCK_SYMBOLS.map(function(sym) {
    return Promise.all([
      getStockQuote(sym),
      getStockDividend(sym)
    ]).then(function(results) {
      var quote = results[0];
      var div = results[1];
      if (quote && div) {
        if (div.annual) quote.dividendAnnual = div.annual;
        if (div.yieldPct) quote.dividendYield = div.yieldPct;
      }
      return [sym, quote];
    });
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

// ✅ Chart history — uses Finnhub for stocks, CoinGecko for crypto
app.get("/api/history/:symbol", function(req, res) {
  var sym = req.params.symbol.toUpperCase();

  // Check if it's a crypto symbol
  var cgIdMap = {
    "BTC": "bitcoin", "ETH": "ethereum", "XRP": "ripple",
    "HBAR": "hedera-hashgraph", "XLM": "stellar",
    "ONDO": "ondo-finance", "W": "wormhole"
  };

  if (cgIdMap[sym]) {
    getCryptoHistory(cgIdMap[sym]).then(function(data) {
      if (!data) return res.json({ success: false, dates: [], closes: [] });
      res.json({ success: true, dates: data.dates, closes: data.closes, afterHoursPrice: null, preMarketPrice: null });
    });
  } else {
    getStockHistory(sym).then(function(data) {
      if (!data) return res.json({ success: false, dates: [], closes: [] });
      res.json({ success: true, dates: data.dates, closes: data.closes, afterHoursPrice: data.afterHoursPrice, preMarketPrice: data.preMarketPrice });
    });
  }
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
