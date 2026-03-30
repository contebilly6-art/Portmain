const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

process.on("uncaughtException", function(e){ console.error("ERR:", e.message); });
process.on("unhandledRejection", function(e){ console.error("REJ:", e ? e.message : e); });

const app = express();
app.use(cors({ origin: "*" }));

const KEY = process.env.FINNHUB_KEY;

const STOCKS = [
  "SPY","QQQ","SOFI","RYCEY","LFMD","NKE","CAKE","TMC","DIA",
  "SOXX","XLK","XLF","XLE","XLV","XLY","XLI","XLRE","XLU","XLB","XLC","XLP"
];

const CRYPTO = {
  "bitcoin":"BTC","ethereum":"ETH","ripple":"XRP",
  "hedera-hashgraph":"HBAR","stellar":"XLM","ondo-finance":"ONDO","wormhole":"W"
};

var cache = {};
var cacheTime = 0;
var busy = false;

function safeFetch(url, ms) {
  return new Promise(function(resolve) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; resolve(null); }
    }, ms || 5000);
    fetch(url).then(function(r) {
      clearTimeout(t);
      if (!done) { done = true; resolve(r.json()); }
    }).catch(function() {
      clearTimeout(t);
      if (!done) { done = true; resolve(null); }
    });
  });
}

function getStock(sym) {
  return safeFetch("https://finnhub.io/api/v1/quote?symbol="+sym+"&token="+KEY, 4000)
    .then(function(d) {
      if (!d || !d.c || d.c === 0) return null;
      var r = { price: d.c, changePct: parseFloat((((d.c-d.pc)/d.pc)*100).toFixed(2)) };
      if (d.ap > 0) r.afterHoursPrice = d.ap;
      if (d.pp > 0) r.preMarketPrice = d.pp;
      return r;
    }).catch(function() { return null; });
}

function getCrypto() {
  var ids = Object.keys(CRYPTO).join(",");
  var url = "https://api.coingecko.com/api/v3/simple/price?ids="+ids+"&vs_currencies=usd&include_24hr_change=true";
  return safeFetch(url, 8000).then(function(d) {
    if (!d) return {};
    var r = {};
    Object.keys(CRYPTO).forEach(function(id) {
      if (d[id]) {
        r[CRYPTO[id]] = {
          price: d[id].usd,
          changePct: parseFloat((d[id].usd_24h_change || 0).toFixed(2))
        };
      }
    });
    return r;
  }).catch(function() { return {}; });
}

function getVIX() {
  return safeFetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d", 6000)
    .then(function(d) {
      try {
        var p = d.chart.result[0].meta.regularMarketPrice;
        var prev = d.chart.result[0].meta.chartPreviousClose || p;
        if (p > 0) return { price: p, changePct: parseFloat((((p-prev)/prev)*100).toFixed(2)) };
      } catch(e) {}
      return null;
    }).catch(function() { return null; });
}

function refresh() {
  if (busy) return;
  busy = true;
  console.log("Refreshing at " + new Date().toISOString());
  var stockJobs = STOCKS.map(function(sym) {
    return getStock(sym).then(function(d) { return { sym: sym, data: d }; });
  });
  Promise.all([Promise.all(stockJobs), getCrypto(), getVIX()])
    .then(function(results) {
      var prices = {};
      var cryptoData = results[1];
      var vixData = results[2];
      Object.keys(cryptoData).forEach(function(k) { prices[k] = cryptoData[k]; });
      results[0].forEach(function(item) { if (item.data) prices[item.sym] = item.data; });
      if (vixData) prices["VIX"] = vixData;
      if (Object.keys(prices).length > 5) {
        cache = prices;
        cacheTime = Date.now();
        console.log("OK: " + Object.keys(prices).length + " symbols | VIX: " + (vixData ? vixData.price : "n/a"));
      }
      busy = false;
    }).catch(function(e) {
      console.error("Refresh failed:", e.message);
      busy = false;
    });
}

function getHistory(sym, isCrypto) {
  if (isCrypto) {
    var url = "https://api.coingecko.com/api/v3/coins/"+isCrypto+"/market_chart?vs_currency=usd&days=180&interval=daily";
    return safeFetch(url, 10000).then(function(d) {
      if (!d || !d.prices || !d.prices.length) return null;
      var dates = [], closes = [];
      d.prices.forEach(function(p) {
        dates.push(new Date(p[0]).toLocaleDateString("en-US",{month:"short",day:"numeric"}));
        closes.push(parseFloat(p[1].toFixed(6)));
      });
      return { dates: dates, closes: closes };
    }).catch(function() { return null; });
  } else {
    var now = Math.floor(Date.now()/1000);
    var from = now - (185*24*60*60);
    var url2 = "https://finnhub.io/api/v1/stock/candle?symbol="+sym+"&resolution=D&from="+from+"&to="+now+"&token="+KEY;
    return safeFetch(url2, 10000).then(function(d) {
      if (!d || d.s !== "ok" || !d.t || !d.t.length) return null;
      var dates = [], closes = [];
      d.t.forEach(function(ts, i) {
        if (d.c[i] != null) {
          dates.push(new Date(ts*1000).toLocaleDateString("en-US",{month:"short",day:"numeric"}));
          closes.push(parseFloat(d.c[i].toFixed(2)));
        }
      });
      return dates.length ? { dates: dates, closes: closes } : null;
    }).catch(function() { return null; });
  }
}

function getDividend(sym) {
  return safeFetch("https://finnhub.io/api/v1/stock/metric?symbol="+sym+"&metric=all&token="+KEY, 5000)
    .then(function(d) {
      if (!d || !d.metric) return null;
      var annual = d.metric["dividendPerShareAnnual"] || null;
      var yld = d.metric["dividendYieldIndicatedAnnual"] || null;
      if (!annual || annual === 0) return null;
      return { annual: parseFloat(annual.toFixed(2)), yieldPct: yld ? parseFloat(yld.toFixed(2)) : null };
    }).catch(function() { return null; });
}

// Routes
app.get("/", function(req, res) {
  res.json({ status: "Portfolio API running", symbols: Object.keys(cache).length, uptime: process.uptime() });
});

app.get("/api/prices", function(req, res) {
  if (!KEY) return res.status(500).json({ success: false, error: "FINNHUB_KEY not set" });
  if (Object.keys(cache).length > 0) {
    res.json({ success: true, prices: cache, updatedAt: new Date(cacheTime).toISOString() });
    if (Date.now() - cacheTime > 60000) refresh();
    return;
  }
  // First request — wait for data
  var attempts = 0;
  refresh();
  var check = setInterval(function() {
    attempts++;
    if (Object.keys(cache).length > 0 || attempts > 30) {
      clearInterval(check);
      res.json({ success: true, prices: cache, updatedAt: new Date(cacheTime).toISOString() });
    }
  }, 500);
});

app.get("/api/history/:sym", function(req, res) {
  var sym = req.params.sym.toUpperCase();
  var CGMAP = { BTC:"bitcoin", ETH:"ethereum", XRP:"ripple", HBAR:"hedera-hashgraph", XLM:"stellar", ONDO:"ondo-finance", W:"wormhole" };
  getHistory(sym, CGMAP[sym] || null).then(function(d) {
    if (!d) return res.json({ success: false, dates: [], closes: [] });
    res.json({ success: true, dates: d.dates, closes: d.closes });
  });
});

// Quote endpoint — works for ANY stock on free Finnhub tier
app.get("/api/quote/:sym", function(req, res) {
  var sym = req.params.sym.toUpperCase();
  getStock(sym).then(function(d) {
    if (!d) return res.json({ success: false, price: 0 });
    res.json({ success: true, price: d.price, changePct: d.changePct });
  });
});

app.get("/api/dividend/:sym", function(req, res) {
  getDividend(req.params.sym.toUpperCase()).then(function(d) {
    if (!d) return res.json({ success: false });
    res.json({ success: true, annual: d.annual, yieldPct: d.yieldPct });
  });
});

// Start
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log("Server started on port " + PORT);
  if (KEY) {
    refresh();
    setInterval(refresh, 60000);
  }
});
