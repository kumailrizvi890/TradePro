"use strict";
/*
 * TradePro terminal frontend.
 *
 * Every number on screen comes from the backend APIs (/api/watchlist,
 * /api/candles, /api/state, /api/order, /api/run), which in turn read live
 * Yahoo Finance data and the Supabase portfolio. The only math done here
 * is display math: SMA 20/50 and RSI 14 series drawn from the fetched
 * candles, and ATR(14) computed from real daily bars for the risk desk.
 * Nothing is simulated, interpolated or invented.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);

const fmtMoney = (n, decimals = 2) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const fmtSigned = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n)}`);
const fmtPct = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const pnlClass = (n) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
// Prices span $0.20 (ADA) to $100k+ (BTC): pick decimals by magnitude.
const fmtPrice = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  return fmtMoney(n, n >= 1 ? 2 : 4);
};
const fmtQty = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const decimals = n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return parseFloat(n.toFixed(decimals)).toLocaleString("en-US", { maximumFractionDigits: decimals });
};
const fmtWhen = (t) => {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const fmtClock = (d) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);

// ---------------------------------------------------------------------------
// Universe — the same 25 symbols the backend tracks (see api/market.py)
// ---------------------------------------------------------------------------
const NAMES = {
  "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "SOL-USD": "Solana", "BNB-USD": "BNB",
  "XRP-USD": "XRP", "ADA-USD": "Cardano", "AVAX-USD": "Avalanche", "DOGE-USD": "Dogecoin",
  "LINK-USD": "Chainlink", "LTC-USD": "Litecoin",
  NVDA: "NVIDIA Corp", TSLA: "Tesla Inc", AAPL: "Apple Inc", MSFT: "Microsoft Corp",
  META: "Meta Platforms Inc", AMD: "Advanced Micro Devices", AMZN: "Amazon.com Inc",
  GOOGL: "Alphabet Inc", PLTR: "Palantir Technologies", COIN: "Coinbase Global",
  AVGO: "Broadcom Inc", NFLX: "Netflix Inc", SPY: "SPDR S&P 500 ETF Trust",
  QQQ: "Invesco QQQ Trust", MSTR: "Strategy Inc",
};
const EQUITIES = ["NVDA", "TSLA", "AAPL", "MSFT", "META", "AMD", "AMZN", "GOOGL", "PLTR", "COIN", "AVGO", "NFLX", "SPY", "QQQ", "MSTR"];
const CRYPTOS = ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "ADA-USD", "AVAX-USD", "DOGE-USD", "LINK-USD", "LTC-USD"];
const ALL_SYMBOLS = [...EQUITIES, ...CRYPTOS];

const CHECK_LABELS = {
  sma_bullish: "SMA 10 > SMA 30",
  rsi_band: "RSI 40–70",
  volume_ok: "Volume ≥ avg",
  breakout: "Near 20d high",
  adx_ok: "ADX ≥ 20",
  trend: "SMA spread",
  regime: "Bull regime",
  rsi_strong: "RSI ≥ 50",
};
const REGIME_CLASS = { BULL_RUN: "bull", BEAR_RUN: "bear", CHOP: "chop", RECOVERY: "recovery" };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  focusSymbol: "NVDA",
  timeframe: "1D",
  side: "buy",
  sizeMode: "risk",
  lastPrice: null,
  lastBars: null,
  atr: null,
  atrSymbol: null,
  equity: null,
  cash: null,
  positions: {},
  liveData: null,
};

let chart = null;
let rsiChart = null;
let candleSeries = null;
let sma20Series = null;
let sma50Series = null;
let volumeSeries = null;
let rsiSeries = null;

// ---------------------------------------------------------------------------
// Display math (computed from fetched candles — same formulas as api/indicators.py)
// ---------------------------------------------------------------------------
function smaSeries(values, period) {
  const out = [];
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j].value;
    out.push({ time: values[i].time, value: sum / period });
  }
  return out;
}

function computeRsiSeries(closes, period = 14) {
  const out = [];
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i].value - closes[i - 1].value;
    if (d > 0) gain += d; else loss += -d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rs = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out.push({ time: closes[period].time, value: rs(avgGain, avgLoss) });
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i].value - closes[i - 1].value;
    const up = Math.max(d, 0);
    const down = Math.max(-d, 0);
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out.push({ time: closes[i].time, value: rs(avgGain, avgLoss) });
  }
  return out;
}

// Real ATR(14): average true range of the last 14 daily bars.
function atrFromBars(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevClose), Math.abs(bars[i].l - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------
function setStatus(message, isError = false) {
  const node = el("data-status");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function setLiveBadge(live) {
  const badge = el("live-badge");
  if (!badge) return;
  state.liveData = live;
  badge.classList.toggle("offline", live === false);
  badge.innerHTML = live === false
    ? '<span class="dot" aria-hidden="true"></span>OFFLINE — LAST KNOWN DATA'
    : '<span class="dot" aria-hidden="true"></span>LIVE DATA';
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
function initCharts() {
  if (typeof LightweightCharts === "undefined") {
    const box = el("chart-container");
    if (box) box.textContent = "Chart library failed to load — check the connection and reload.";
    return;
  }
  const container = el("chart-container");
  const rsiContainer = el("rsi-container");
  if (!container || !rsiContainer) return;
  chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 380,
    layout: { textColor: "#7d938a", background: { type: "solid", color: "#0a100d" } },
    grid: { vertLines: { color: "rgba(27,43,34,0.6)" }, horzLines: { color: "rgba(27,43,34,0.6)" } },
    timeScale: { borderColor: "#1b2b22", rightOffset: 4 },
    rightPriceScale: { borderColor: "#1b2b22" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#2bff9e", downColor: "#ff5c5c", wickUpColor: "#2bff9e", wickDownColor: "#ff5c5c", borderVisible: false,
  });
  volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "",
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale("").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  sma20Series = chart.addLineSeries({ color: "#ffcf5c", lineWidth: 2, title: "SMA 20", priceLineVisible: false, lastValueVisible: false });
  sma50Series = chart.addLineSeries({ color: "#5aa2ff", lineWidth: 2, title: "SMA 50", priceLineVisible: false, lastValueVisible: false });
  rsiChart = LightweightCharts.createChart(rsiContainer, {
    width: rsiContainer.clientWidth,
    height: 110,
    layout: { textColor: "#7d938a", background: { type: "solid", color: "#0a100d" } },
    grid: { vertLines: { color: "rgba(27,43,34,0.6)" }, horzLines: { color: "rgba(27,43,34,0.6)" } },
    timeScale: { visible: false },
    rightPriceScale: { borderColor: "#1b2b22" },
  });
  rsiSeries = rsiChart.addLineSeries({
    color: "#b388ff", lineWidth: 2, title: "RSI 14", priceLineVisible: false, lastValueVisible: false,
  });
  rsiSeries.createPriceLine({ price: 70, color: "rgba(91,114,102,0.5)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
  rsiSeries.createPriceLine({ price: 30, color: "rgba(91,114,102,0.5)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
  });
  chart.subscribeCrosshairMove((param) => {
    const box = el("ohlc");
    if (!box || !state.lastBars) return;
    let bar = state.lastBars[state.lastBars.length - 1];
    if (param.time) {
      const found = state.lastBars.find((b) => Math.floor(b.t / 1000) === param.time);
      if (found) bar = found;
    }
    renderOhlc(bar);
  });
  window.addEventListener("resize", () => {
    chart.applyOptions({ width: container.clientWidth });
    rsiChart.applyOptions({ width: rsiContainer.clientWidth });
  });
}

function renderOhlc(bar) {
  const box = el("ohlc");
  if (!box || !bar) return;
  const chg = bar.o ? ((bar.c - bar.o) / bar.o) * 100 : null;
  box.innerHTML = `O <b>${fmtPrice(bar.o)}</b> &nbsp; H <b>${fmtPrice(bar.h)}</b> &nbsp; L <b>${fmtPrice(bar.l)}</b> &nbsp; C <b>${fmtPrice(bar.c)}</b> &nbsp; Chg <b class="${pnlClass(chg)}">${chg == null ? "—" : (chg > 0 ? "+" : "") + chg.toFixed(2) + "%"}</b>`;
}

async function loadCandles() {
  if (!candleSeries) return;
  try {
    const res = await fetch(`/api/candles?symbol=${state.focusSymbol}&timeframe=${state.timeframe}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const bars = data.bars || [];
    if (!bars.length) throw new Error("No candles returned for this symbol and timeframe.");
    state.lastBars = bars;
    state.lastPrice = data.price;
    const candleData = bars.map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c }));
    const closes = bars.map((b) => ({ time: Math.floor(b.t / 1000), value: b.c }));
    candleSeries.setData(candleData);
    volumeSeries.setData(bars.map((b) => ({
      time: Math.floor(b.t / 1000),
      value: b.v,
      color: b.c >= b.o ? "rgba(43,255,158,0.35)" : "rgba(255,92,92,0.35)",
    })));
    sma20Series.setData(smaSeries(closes, 20));
    sma50Series.setData(smaSeries(closes, 50));
    rsiSeries.setData(computeRsiSeries(closes, 14));
    chart.timeScale().fitContent();
    const last = bars[bars.length - 1];
    renderOhlc(last);
    el("chart-symbol").textContent = data.symbol;
    el("chart-company").textContent = NAMES[data.symbol] || "";
    el("chart-price").textContent = fmtPrice(data.price);
    const changeNode = el("chart-change");
    changeNode.textContent = fmtPct(data.change_pct);
    changeNode.className = `symbol-change ${pnlClass(data.change_pct)}`;
    const badge = el("regime-badge");
    if (data.signal) {
      badge.textContent = data.signal.regime || "—";
      badge.className = `regime-badge ${REGIME_CLASS[data.signal.regime] || "chop"}`;
      renderChecks(data.signal);
    }
    updateOrderPreview();
    updateRiskExample();
  } catch (err) {
    setStatus(`Chart unavailable: ${err.message}`, true);
  }
}

function renderChecks(signal) {
  const row = el("checks-row");
  if (!row || !signal.checks) return;
  const checks = signal.checks;
  row.innerHTML = Object.keys(CHECK_LABELS).map((key) => {
    if (!(key in checks)) return "";
    const passed = checks[key];
    return `<span class="check-badge ${passed ? "pass" : "fail"}">${passed ? "✓" : "✕"} ${CHECK_LABELS[key]}</span>`;
  }).join("") + `<span class="confluence-tag">Confluence ${signal.passed}/${signal.total} — entry needs 7</span>`;
}

// ATR comes from daily bars regardless of the chart timeframe, because the
// stop in the order ticket is defined on the daily ATR(14).
async function loadDailyAtr() {
  const symbol = state.focusSymbol;
  try {
    const res = await fetch(`/api/candles?symbol=${symbol}&timeframe=1D`);
    const data = await res.json();
    if (data.error || !data.bars) throw new Error(data.error || "No daily bars.");
    state.atr = atrFromBars(data.bars, 14);
    state.atrSymbol = symbol;
  } catch (err) {
    state.atr = null;
    state.atrSymbol = symbol;
  }
  updateOrderPreview();
  updateRiskExample();
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
function buildDeskSelect() {
  const select = el("desk-symbol");
  if (!select) return;
  const group = (label, symbols) =>
    `<optgroup label="${label}">${symbols.map((s) => `<option value="${s}" ${s === state.focusSymbol ? "selected" : ""}>${s} — ${NAMES[s] || ""}</option>`).join("")}</optgroup>`;
  select.innerHTML = group("US Equities", EQUITIES) + group("Crypto", CRYPTOS);
}

async function loadWatchlist() {
  const body = el("watchlist-body");
  try {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const rows = [];
    const renderGroup = (label, items) => {
      if (!items || !items.length) return;
      rows.push(`<tr class="group-row"><td colspan="5">${label}</td></tr>`);
      items.forEach((q) => {
        const trend = q.change_pct == null ? "—" : q.change_pct >= 0 ? "▲ Up" : "▼ Down";
        rows.push(`<tr class="watch-row ${q.symbol === state.focusSymbol ? "active" : ""}" data-symbol="${q.symbol}" tabindex="0" role="button" aria-label="Load ${q.symbol} on the chart">` +
          `<td><strong>${q.symbol}</strong></td><td>${NAMES[q.symbol] || ""}</td><td>${fmtPrice(q.price)}</td>` +
          `<td class="${pnlClass(q.change_pct)}">${fmtPct(q.change_pct)}</td><td class="${pnlClass(q.change_pct)}">${trend}</td></tr>`);
      });
    };
    renderGroup("US Equities", data.equities);
    renderGroup("Crypto · 24/7", data.crypto);
    body.innerHTML = rows.join("") || '<tr><td colspan="5" class="empty">No quotes returned.</td></tr>';
    el("glance-symbols").textContent = data.count || ALL_SYMBOLS.length;
    body.querySelectorAll(".watch-row").forEach((row) => {
      const pick = () => selectSymbol(row.dataset.symbol);
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
  } catch (err) {
    if (body) body.innerHTML = `<tr><td colspan="5" class="empty">Live quotes unavailable — ${err.message}</td></tr>`;
    setStatus(`Watchlist unavailable: ${err.message}`, true);
  }
}

function selectSymbol(symbol) {
  if (!symbol || symbol === state.focusSymbol) return;
  state.focusSymbol = symbol;
  const select = el("desk-symbol");
  if (select) select.value = symbol;
  document.querySelectorAll(".watch-row").forEach((row) => row.classList.toggle("active", row.dataset.symbol === symbol));
  loadCandles();
  loadDailyAtr();
  loadState();
  document.getElementById("chart").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Portfolio state: holdings, order log, equity curve
// ---------------------------------------------------------------------------
async function loadState() {
  try {
    const res = await fetch(`/api/state?focus=${state.focusSymbol}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.equity = data.equity;
    state.cash = data.cash;
    state.positions = {};
    (data.positions || []).forEach((p) => { state.positions[p.symbol] = p; });
    setLiveBadge(data.live_data !== false);
    el("glance-equity").textContent = fmtMoney(data.equity, 0);
    el("eq-equity").textContent = fmtMoney(data.equity, 0);
    el("eq-cash").textContent = fmtMoney(data.cash);
    el("eq-power").textContent = fmtMoney(data.cash);
    const pnlNode = el("eq-openpnl");
    pnlNode.textContent = fmtSigned(data.unrealized);
    pnlNode.className = pnlClass(data.unrealized);
    el("holdings-count").textContent = `${data.open_count || 0} position${data.open_count === 1 ? "" : "s"}`;
    renderPositions(data.positions || []);
    renderTrades(data.trades || []);
    drawEquityCurve(data.trades || [], data.starting_cash || 100000, data.equity);
    const tag = el("build-tag");
    if (tag) tag.textContent = `build main · last autopilot run ${data.last_run ? fmtWhen(data.last_run) : "—"}`;
    setStatus(`Live data · updated ${fmtClock(new Date())} PT`);
    updateOrderPreview();
    updateRiskExample();
  } catch (err) {
    setStatus(`Portfolio unavailable: ${err.message}`, true);
  }
}

function renderPositions(positions) {
  const body = el("positions-body");
  if (!body) return;
  if (!positions.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No open positions — flat for now.</td></tr>';
    return;
  }
  body.innerHTML = positions.map((p) => {
    const pnl = p.mark_price != null ? (p.mark_price - p.entry_price) * p.qty : null;
    return `<tr><td><strong>${p.symbol}</strong></td><td>${fmtQty(p.qty)}</td><td>${fmtPrice(p.entry_price)}</td>` +
      `<td>${fmtPrice(p.mark_price)}</td><td>${fmtPrice(p.stop_loss)}</td><td>${fmtPrice(p.take_profit)}</td>` +
      `<td class="${pnlClass(pnl)}">${fmtSigned(pnl)}</td></tr>`;
  }).join("");
}

function renderTrades(trades) {
  const body = el("trades-body");
  if (!body) return;
  const rows = trades.slice(0, 12);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No trades recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((t) => {
    const pnl = t.pnl != null ? t.pnl : t.realized_pnl;
    return `<tr><td>${fmtWhen(t.time || t.created_at)}</td><td><strong>${t.symbol}</strong></td>` +
      `<td class="${t.side === "buy" ? "positive" : "negative"}">${(t.side || "").toUpperCase()}</td>` +
    `<td>${fmtQty(t.qty)}</td><td>${fmtPrice(t.price)}</td>` +
      `<td class="${pnlClass(pnl)}">${fmtSigned(pnl)}</td><td>${t.reason || t.strategy || ""}</td></tr>`;
  }).join("");
}

// Equity path built from the recorded trades: start at starting cash, step
// by each closed trade's realized P&L, end at current equity.
function drawEquityCurve(trades, startingCash, equity) {
  const canvas = el("equity-curve");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 640;
  const height = 64;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const points = [{ x: 0, y: startingCash }];
  let running = startingCash;
  const closed = trades
    .filter((t) => (t.pnl != null ? t.pnl : t.realized_pnl) != null)
    .map((t) => ({ when: t.time || t.created_at, pnl: t.pnl != null ? t.pnl : t.realized_pnl }))
    .sort((a, b) => new Date(a.when) - new Date(b.when));
  closed.forEach((t) => { running += t.pnl; points.push({ x: points.length, y: running }); });
  if (equity != null) points.push({ x: points.length, y: equity });
  const values = points.map((p) => p.y);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.1, 1);
  const px = (i) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * (width - 8) + 4);
  const py = (v) => height - 6 - ((v - (min - pad)) / (max - min + 2 * pad)) * (height - 12);
  ctx.beginPath();
  ctx.moveTo(px(0), py(points[0].y));
  points.forEach((p, i) => ctx.lineTo(px(i), py(p.y)));
  ctx.strokeStyle = "#2bff9e";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(px(points.length - 1), height);
  ctx.lineTo(px(0), height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(43,255,158,0.25)");
  gradient.addColorStop(1, "rgba(43,255,158,0)");
  ctx.fillStyle = gradient;
  ctx.fill();
  const note = el("equity-note");
  if (note) note.textContent = closed.length
    ? `Equity path built from ${closed.length} recorded closed trade${closed.length === 1 ? "" : "s"}, starting from ${fmtMoney(startingCash, 0)}.`
    : `No closed trades recorded yet — flat at the starting balance of ${fmtMoney(startingCash, 0)}.`;
}

// ---------------------------------------------------------------------------
// Risk desk
// ---------------------------------------------------------------------------
function stopDistance() {
  return state.atr != null ? 2 * state.atr : null;
}

function updateRiskExample() {
  const node = el("risk-example");
  if (!node) return;
  if (state.lastPrice == null || state.atr == null) {
    node.textContent = "Live example loading — needs a price and an ATR(14) from the daily bars.";
    return;
  }
  const dist = stopDistance();
  const shares = 250 / dist;
  node.textContent = `Live example — ${state.focusSymbol}: entry ${fmtPrice(state.lastPrice)} · ATR(14) ${fmtPrice(state.atr)} · stop ${fmtPrice(state.lastPrice - dist)} · $250 risk → ${fmtQty(shares)} shares.`;
}

function updateOrderPreview() {
  const price = state.lastPrice;
  const atr = state.atr;
  const set = (id, text) => { const node = el(id); if (node) node.textContent = text; };
  const btn = el("fill-order-btn");
  const riskInput = el("risk-amount");
  const sharesInput = el("shares-amount");
  if (price == null || atr == null) {
    ["prev-entry", "prev-atr", "prev-stop", "prev-tp", "prev-dist", "prev-shares", "prev-notional"].forEach((id) => set(id, "—"));
    if (btn) btn.disabled = true;
    return;
  }
  const dist = stopDistance();
  const buy = state.side === "buy";
  const stop = buy ? price - dist : price + dist;
  const tp = buy ? price + 2 * dist : price - 2 * dist;
  const holding = state.positions[state.focusSymbol];
  let shares = null;
  let notional = null;
  let capped = false;
  if (!buy) {
    shares = holding ? holding.qty : 0;
    notional = shares * price;
  } else if (state.sizeMode === "risk") {
    const riskDollars = Math.max(parseFloat(riskInput.value) || 0, 0);
    shares = riskDollars / dist;
    if (state.cash != null && shares * price > state.cash) {
      shares = state.cash / price;
      capped = true;
    }
    notional = shares * price;
  } else {
    shares = Math.max(parseFloat(sharesInput.value) || 0, 0);
    notional = shares * price;
  }
  set("prev-entry", fmtPrice(price));
  set("prev-atr", fmtPrice(atr));
  set("prev-stop", fmtPrice(stop));
  set("prev-tp", fmtPrice(tp));
  set("prev-dist", fmtPrice(dist));
  set("prev-shares", buy ? `${fmtQty(shares)} shares${capped ? " (capped by available cash)" : ""}` : `${fmtQty(shares)} shares (closes position)`);
  set("prev-notional", fmtMoney(notional));
  const label = el("prev-shares-label");
  if (label) label.textContent = buy ? "Shares" : "Shares — sell";
  if (btn) {
    btn.textContent = `FILL ORDER — ${buy ? "BUY" : "SELL"}`;
    btn.classList.toggle("sell", !buy);
    btn.disabled = !buy && !holding;
  }
}

function setSide(side) {
  state.side = side;
  el("side-buy").setAttribute("aria-pressed", String(side === "buy"));
  el("side-sell").setAttribute("aria-pressed", String(side === "sell"));
  const sell = side === "sell";
  ["risk-amount", "shares-amount", "size-risk", "size-shares"].forEach((id) => { el(id).disabled = sell; });
  updateOrderPreview();
}

function setSizeMode(mode) {
  state.sizeMode = mode;
  el("size-risk").setAttribute("aria-pressed", String(mode === "risk"));
  el("size-shares").setAttribute("aria-pressed", String(mode === "shares"));
  el("risk-field").hidden = mode !== "risk";
  el("shares-field").hidden = mode !== "shares";
  updateOrderPreview();
}

async function placeOrder(event) {
  event.preventDefault();
  const result = el("order-result");
  const btn = el("fill-order-btn");
  const price = state.lastPrice;
  const atr = state.atr;
  if (price == null || atr == null) {
    result.textContent = "Live data is not loaded yet — wait a moment and try again.";
    result.className = "order-result error";
    return;
  }
  const dist = stopDistance();
  const buy = state.side === "buy";
  let payload;
  if (!buy) {
    payload = { symbol: state.focusSymbol, side: "sell", risk_pct: 1, quantity: "auto" };
  } else if (state.sizeMode === "risk") {
    const riskDollars = Math.max(parseFloat(el("risk-amount").value) || 0, 0);
    if (riskDollars <= 0 || state.equity == null) {
      result.textContent = "Enter a risk amount greater than $0.";
      result.className = "order-result error";
      return;
    }
    payload = {
      symbol: state.focusSymbol,
      side: "buy",
      risk_pct: (riskDollars / state.equity) * 100,
      quantity: "auto",
      stop_loss: +(price - dist).toFixed(6),
      take_profit: +(price + 2 * dist).toFixed(6),
    };
  } else {
    const shares = Math.max(parseFloat(el("shares-amount").value) || 0, 0);
    if (shares <= 0 || state.equity == null) {
      result.textContent = "Enter a share quantity greater than 0.";
      result.className = "order-result error";
      return;
    }
    payload = {
      symbol: state.focusSymbol,
      side: "buy",
      risk_pct: ((shares * dist) / state.equity) * 100,
      quantity: shares,
      stop_loss: +(price - dist).toFixed(6),
      take_profit: +(price + 2 * dist).toFixed(6),
    };
  }
  btn.disabled = true;
  btn.textContent = "FILLING…";
  result.textContent = "";
  try {
    const res = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Order failed (HTTP ${res.status}).`);
    result.textContent = data.message || `Filled: ${payload.side.toUpperCase()} ${state.focusSymbol}.`;
    result.className = "order-result success";
    await loadState();
  } catch (err) {
    result.textContent = err.message;
    result.className = "order-result error";
  } finally {
    updateOrderPreview();
  }
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------
async function runAutopilot() {
  const btn = el("run-autopilot-btn");
  const out = el("autopilot-output");
  const status = el("autopilot-status");
  btn.disabled = true;
  status.textContent = "Running…";
  try {
    const res = await fetch("/api/run", { method: "POST" });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const lines = [`Ran in ${data.ms} ms across ${data.symbols.length} symbols.`];
    if (!data.actions.length) {
      lines.push("No actions — no symbol passed the 7/8 confluence gate.");
    } else {
      data.actions.forEach((a) => {
      lines.push(`${(a.side || "").toUpperCase()} ${fmtQty(a.qty)} ${a.symbol} @ ${fmtPrice(a.price)} - ${a.reason || ""}`);
      });
      }
    out.textContent = lines.join("\n");
    out.hidden = false;
    status.textContent = `Last run ${fmtClock(new Date())} PT`;
    await loadState();
  } catch (err) {
    out.textContent = `Autopilot failed: ${err.message}`;
    out.hidden = false;
    status.textContent = "";
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function tickClock() {
  el("clock").textContent = `${fmtClock(new Date())} PT`;
}

function bindEvents() {
  document.querySelectorAll(".tf").forEach((button) => {
    button.addEventListener("click", () => {
      state.timeframe = button.dataset.tf;
      document.querySelectorAll(".tf").forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-pressed", String(b === button));
      });
      loadCandles();
    });
  });
  el("side-buy").addEventListener("click", () => setSide("buy"));
  el("side-sell").addEventListener("click", () => setSide("sell"));
  el("size-risk").addEventListener("click", () => setSizeMode("risk"));
  el("size-shares").addEventListener("click", () => setSizeMode("shares"));
  el("desk-symbol").addEventListener("change", (e) => selectSymbol(e.target.value));
  el("risk-amount").addEventListener("input", updateOrderPreview);
  el("shares-amount").addEventListener("input", updateOrderPreview);
  el("order-form").addEventListener("submit", placeOrder);
  el("run-autopilot-btn").addEventListener("click", runAutopilot);
}

buildDeskSelect();
initCharts();
bindEvents();
tickClock();
setInterval(tickClock, 1000);
loadWatchlist();
loadCandles();
loadDailyAtr();
loadState();
setInterval(() => { if (!document.hidden) loadWatchlist(); }, 60000);
setInterval(() => { if (!document.hidden) loadCandles(); }, 60000);
setInterval(() => { if (!document.hidden) loadState(); }, 45000);
