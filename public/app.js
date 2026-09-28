const fmtMoney = (n, decimals = 2) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const fmtSigned = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmtMoney(n)}`);
const fmtPct = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const pnlClass = (n) => (n > 0 ? "positive" : n < 0 ? "negative" : "");

let state = { focusSymbol: "BTC-USD", timeframe: "1D", side: "buy", lastSignal: null, lastPrice: null, lastAtr: null, feed: [] };

function pushFeed(text) {
  state.feed.unshift({ time: new Date(), text });
  state.feed = state.feed.slice(0, 30);
  renderFeed();
}

function renderFeed() {
  const el = document.getElementById("live-feed-list");
  if (!state.feed.length) {
    el.innerHTML = `<div class="lf-empty">No activity yet.</div>`;
    return;
  }
  el.innerHTML = state.feed
    .map((f) => `<div class="lf-item"><span class="lf-time">${f.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><span class="lf-text">${f.text}</span></div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

async function loadWatchlist() {
  try {
    const res = await fetch("/api/watchlist");
    const data = await res.json();
    document.getElementById("watchlist-count").textContent = `${data.count} symbols`;
    renderWatchlistSection("watchlist-crypto", data.crypto);
    renderWatchlistSection("watchlist-equities", data.equities);
  } catch (err) {
    pushFeed(`Watchlist load failed: ${err.message}`);
  }
}

function renderWatchlistSection(elId, quotes) {
  const el = document.getElementById(elId);
  if (!quotes || !quotes.length) {
    el.innerHTML = `<div class="watch-row"><span class="watch-symbol" style="color:var(--ink-faint)">unavailable</span></div>`;
    return;
  }
  el.innerHTML = quotes
    .map((q) => {
      const active = q.symbol === state.focusSymbol ? "active" : "";
      const decimals = q.price < 5 ? 4 : 2;
      return `
      <div class="watch-row ${active}" data-symbol="${q.symbol}">
        <span class="watch-symbol">${q.symbol.replace("-USD", "")}</span>
        <span class="watch-right">
          <span class="watch-price">${q.price.toFixed(decimals)}</span>
          <span class="watch-change ${pnlClass(q.change_pct)}">${fmtPct(q.change_pct)}</span>
        </span>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".watch-row[data-symbol]").forEach((row) => {
    row.addEventListener("click", () => {
      state.focusSymbol = row.dataset.symbol;
      document.querySelectorAll(".watch-row").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
      loadCandles();
      loadState();
    });
  });
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

let mainChart, rsiChart, candleSeries, smaFastSeries, smaSlowSeries, volumeSeries, rsiLineSeries;

function initCharts() {
  const chartOpts = {
    layout: { background: { color: "#10141b" }, textColor: "#8b93a1" },
    grid: { vertLines: { color: "#1f242e" }, horzLines: { color: "#1f242e" } },
    timeScale: { borderColor: "#1f242e", timeVisible: true },
    rightPriceScale: { borderColor: "#1f242e" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  };

  mainChart = LightweightCharts.createChart(document.getElementById("chart-container"), {
    ...chartOpts,
    width: document.getElementById("chart-container").clientWidth,
    height: 360,
  });
  candleSeries = mainChart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#ef4444", borderVisible: false,
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
  });
  smaFastSeries = mainChart.addLineSeries({ color: "#ff8c3a", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
  smaSlowSeries = mainChart.addLineSeries({ color: "#3b82f6", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
  volumeSeries = mainChart.addHistogramSeries({
    priceFormat: { type: "volume" }, priceScaleId: "vol",
    color: "#2a3140",
  });
  mainChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  rsiChart = LightweightCharts.createChart(document.getElementById("rsi-container"), {
    ...chartOpts,
    width: document.getElementById("rsi-container").clientWidth,
    height: 90,
  });
  rsiLineSeries = rsiChart.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

  mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
  });
  rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range) mainChart.timeScale().setVisibleLogicalRange(range);
  });

  window.addEventListener("resize", () => {
    mainChart.resize(document.getElementById("chart-container").clientWidth, 360);
    rsiChart.resize(document.getElementById("rsi-container").clientWidth, 90);
  });
}

function computeRsiSeries(closes, times, period = 14) {
  if (closes.length < period + 1) return [];
  const out = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out.push({ time: times[period], value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: times[i], value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
  }
  return out;
}

async function loadCandles() {
  try {
    const res = await fetch(`/api/candles?symbol=${encodeURIComponent(state.focusSymbol)}&timeframe=${state.timeframe}`);
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const data = await res.json();

    const candleData = data.bars.map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = data.bars.map((b) => ({ time: Math.floor(b.t / 1000), value: b.v, color: b.c >= b.o ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)" }));
    candleSeries.setData(candleData);
    volumeSeries.setData(volData);
    smaFastSeries.setData(data.sma_fast.map((p) => ({ time: Math.floor(p.t / 1000), value: p.v })));
    smaSlowSeries.setData(data.sma_slow.map((p) => ({ time: Math.floor(p.t / 1000), value: p.v })));

    const closes = data.bars.map((b) => b.c);
    const times = data.bars.map((b) => Math.floor(b.t / 1000));
    rsiLineSeries.setData(computeRsiSeries(closes, times));

    mainChart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();

    document.getElementById("chart-symbol").textContent = data.symbol;
    document.getElementById("chart-price").textContent = data.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: data.price < 5 ? 4 : 2 });
    const changeEl = document.getElementById("chart-change");
    changeEl.textContent = fmtPct(data.change_pct);
    changeEl.className = `symbol-change ${pnlClass(data.change_pct)}`;

    state.lastSignal = data.signal;
    state.lastPrice = data.price;
    renderRegimeBadge(data.signal);
    renderChecks(data.signal);
    renderLab(data.signal, data.symbol);
  } catch (err) {
    pushFeed(`Chart load failed for ${state.focusSymbol}: ${err.message}`);
  }
}

function renderRegimeBadge(signal) {
  const el = document.getElementById("regime-badge");
  if (!signal) { el.textContent = "—"; el.className = "regime-badge"; return; }
  el.textContent = signal.regime;
  el.className = `regime-badge ${signal.regime === "BULL_RUN" ? "bull" : signal.regime === "BEAR_RUN" ? "bear" : signal.regime === "CHOP" ? "chop" : "recovery"}`;
}

function renderChecks(signal) {
  const el = document.getElementById("checks-row");
  if (!signal) { el.innerHTML = `<span class="confluence-tag">Not enough history yet for this symbol.</span>`; return; }
  const labels = {
    RSI: `RSI ${signal.rsi}`,
    Momentum: `Momentum ${fmtPct(signal.momentum_pct)}`,
    Volatility: `Volatility ${signal.volatility_pct}%`,
    Volume: `Volume ${signal.volume_ratio}x`,
    ADX: `ADX ${signal.adx}`,
    "EMA Fast": `EMA Fast ${fmtPct(signal.ema_fast_pct)}`,
    "EMA Slow": `EMA Slow ${fmtPct(signal.ema_slow_pct)}`,
    MACD: `MACD ${signal.macd}`,
  };
  const badges = Object.entries(signal.checks)
    .map(([k, passed]) => `<span class="check-badge ${passed ? "pass" : "fail"}">${passed ? "✓" : "✕"} ${labels[k]}</span>`)
    .join("");
  el.innerHTML = badges + `<span class="confluence-tag">${signal.passed}/${signal.total} · need ${document.getElementById("hs-readiness").dataset.entry || 7}</span>`;
}

// ---------------------------------------------------------------------------
// State (equity, positions, trades)
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    const res = await fetch(`/api/state?focus=${encodeURIComponent(state.focusSymbol)}`);
    const data = await res.json();

    setHeaderStat("hs-equity", fmtMoney(data.equity));
    setHeaderStat("hs-daypnl", fmtSigned(data.day_pnl), pnlClass(data.day_pnl));
    setHeaderStat("hs-open", String(data.open_count));
    setHeaderStat("hs-readiness", `${data.readiness}%`);
    document.getElementById("hs-readiness").dataset.entry = data.confluence_entry;

    const liveBadge = document.getElementById("live-badge");
    liveBadge.classList.toggle("offline", !data.live_data);
    document.getElementById("build-tag").textContent = `build ${data.build}`;

    renderPositions(data.positions);
    renderActivity(data.trades);

    const summary = document.getElementById("positions-summary");
    summary.textContent = `${data.closed_count} closed · ${data.win_rate != null ? data.win_rate + "% win" : "—"} · ${fmtSigned(data.realized_pnl_total)} realized`;

    document.getElementById("agent-strategy-name").textContent = data.strategy;
    document.getElementById("agent-threshold").textContent = data.confluence_entry;
    document.getElementById("agent-universe").textContent = data.strategy_universe.join(", ");
    document.getElementById("agent-entry").textContent = `${data.confluence_entry}/8 checks`;
    document.getElementById("lab-symbol").textContent = data.focus_symbol;

    updateOrderPreview();
  } catch (err) {
    pushFeed(`State refresh failed: ${err.message}`);
  }
}

function setHeaderStat(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "hvalue" + (cls ? " " + cls : "");
}

function renderPositions(positions) {
  const body = document.getElementById("positions-body");
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No open positions.</td></tr>`;
    return;
  }
  body.innerHTML = positions
    .map((p) => `
    <tr>
      <td>${p.symbol}</td><td>${p.qty}</td><td>${fmtMoney(p.entry_price)}</td><td>${fmtMoney(p.mark_price)}</td>
      <td>${p.stop_loss != null ? fmtMoney(p.stop_loss) : "—"}</td><td>${p.take_profit != null ? fmtMoney(p.take_profit) : "—"}</td>
      <td class="${pnlClass(p.unrealized_pnl) === "positive" ? "pnl-pos" : pnlClass(p.unrealized_pnl) === "negative" ? "pnl-neg" : ""}">${fmtSigned(p.unrealized_pnl)}</td>
    </tr>`)
    .join("");
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderActivity(trades) {
  const el = document.getElementById("activity-body");
  if (!trades.length) {
    el.innerHTML = `<tr><td colspan="8" class="empty">No trades yet.</td></tr>`;
    return;
  }
  el.innerHTML = trades
    .map((t) => `
    <tr>
      <td>${timeAgo(t.created_at)}</td><td>${t.symbol}</td>
      <td class="side-${t.side}">${t.side.toUpperCase()}</td><td>${t.qty}</td><td>${fmtMoney(t.price)}</td>
      <td class="${pnlClass(t.realized_pnl) === "positive" ? "pnl-pos" : pnlClass(t.realized_pnl) === "negative" ? "pnl-neg" : ""}">${t.realized_pnl != null ? fmtSigned(t.realized_pnl) : "—"}</td>
      <td>${t.strategy}</td><td>${t.reason || ""}</td>
    </tr>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Order ticket
// ---------------------------------------------------------------------------

function updateOrderPreview() {
  const price = state.lastPrice;
  const riskPct = parseFloat(document.getElementById("risk-pct").value) || 1;
  document.getElementById("prev-entry").textContent = price ? fmtMoney(price) : "—";
  if (!price) return;

  const stopInput = document.getElementById("stop-loss").value;
  const tpInput = document.getElementById("take-profit").value;
  document.getElementById("prev-risk").textContent = `${riskPct}%`;

  const stop = stopInput ? parseFloat(stopInput) : null;
  const tp = tpInput ? parseFloat(tpInput) : null;
  if (stop) {
    const riskDist = Math.abs(price - stop);
    document.getElementById("prev-rr").textContent = tp ? `${(Math.abs(tp - price) / riskDist).toFixed(1)}R` : "2.0R (auto)";
  } else {
    document.getElementById("prev-rr").textContent = "2.0R (auto)";
  }

  const qtyInput = document.getElementById("order-qty").value;
  if (qtyInput && qtyInput !== "auto") {
    const qty = parseFloat(qtyInput);
    document.getElementById("prev-qty").textContent = qty || "—";
    document.getElementById("prev-notional").textContent = qty ? fmtMoney(qty * price) : "—";
  } else {
    document.getElementById("prev-qty").textContent = "auto";
    document.getElementById("prev-notional").textContent = "computed at order time";
  }
}

async function placeOrder() {
  const btn = document.getElementById("place-order-btn");
  const resultEl = document.getElementById("order-result");
  btn.disabled = true;
  btn.textContent = "Placing…";
  resultEl.textContent = "";
  resultEl.className = "order-result";

  const body = {
    symbol: state.focusSymbol,
    side: state.side,
    risk_pct: parseFloat(document.getElementById("risk-pct").value) || 1,
    quantity: document.getElementById("order-qty").value || "auto",
    take_profit: document.getElementById("take-profit").value || null,
    stop_loss: document.getElementById("stop-loss").value || null,
  };

  try {
    const res = await fetch("/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "order failed");
    resultEl.className = "order-result success";
    resultEl.textContent = `${data.side.toUpperCase()} ${data.qty} ${data.symbol} @ ${fmtMoney(data.price)}${data.stop_loss ? `\nstop ${fmtMoney(data.stop_loss)} · target ${fmtMoney(data.take_profit)}` : ""}`;
    pushFeed(`<strong>${data.side.toUpperCase()}</strong> ${data.qty} ${data.symbol} @ ${fmtMoney(data.price)} (manual order)`);
    await loadState();
  } catch (err) {
    resultEl.className = "order-result error";
    resultEl.textContent = err.message;
    pushFeed(`Order failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Place Order";
  }
}

function setStopFromAtrMultiple(mult) {
  if (!state.lastPrice) return;
  const closes = null; // ATR not computed client-side; approximate from volatility if needed
  // Use the daily signal's volatility as a rough ATR proxy when exact ATR isn't available client-side.
  const approxAtr = state.lastSignal ? state.lastPrice * (state.lastSignal.volatility_pct / 100) * 2 : state.lastPrice * 0.02;
  const stop = state.side === "buy" ? state.lastPrice - approxAtr * mult : state.lastPrice + approxAtr * mult;
  document.getElementById("stop-loss").value = stop.toFixed(4);
  updateOrderPreview();
}

function setTakeProfitFromR(rMult) {
  if (!state.lastPrice) return;
  const stopVal = parseFloat(document.getElementById("stop-loss").value);
  const riskDist = stopVal ? Math.abs(state.lastPrice - stopVal) : state.lastPrice * 0.02;
  const tp = state.side === "buy" ? state.lastPrice + riskDist * rMult : state.lastPrice - riskDist * rMult;
  document.getElementById("take-profit").value = tp.toFixed(4);
  updateOrderPreview();
}

// ---------------------------------------------------------------------------
// Lab panel
// ---------------------------------------------------------------------------

function renderLab(signal) {
  const checksEl = document.getElementById("lab-checks");
  if (!signal) { checksEl.innerHTML = `<div class="lf-empty">No signal available.</div>`; return; }
  checksEl.innerHTML = Object.entries(signal.checks)
    .map(([k, v]) => `<div class="lab-row"><span>${k}</span><span style="color:${v ? "var(--green)" : "var(--red)"}">${v ? "PASS" : "FAIL"}</span></div>`)
    .join("");
  evaluateLabThreshold();
}

function evaluateLabThreshold() {
  const threshold = parseInt(document.getElementById("lab-threshold-slider").value, 10);
  document.getElementById("lab-threshold-val").textContent = threshold;
  const verdictEl = document.getElementById("lab-verdict");
  if (!state.lastSignal) { verdictEl.textContent = "—"; return; }
  const would = state.lastSignal.passed >= threshold;
  verdictEl.textContent = would
    ? `At this threshold, ${state.focusSymbol} WOULD trigger an entry (${state.lastSignal.passed}/8 passing).`
    : `At this threshold, ${state.focusSymbol} would NOT trigger (${state.lastSignal.passed}/8 passing, needs ${threshold}).`;
  verdictEl.style.color = would ? "var(--green)" : "var(--red)";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel-view").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

document.querySelectorAll(".tf").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tf").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.timeframe = btn.dataset.tf;
    loadCandles();
  });
});

document.getElementById("side-buy").addEventListener("click", () => {
  state.side = "buy";
  document.getElementById("side-buy").classList.add("active");
  document.getElementById("side-sell").classList.remove("active");
});
document.getElementById("side-sell").addEventListener("click", () => {
  state.side = "sell";
  document.getElementById("side-sell").classList.add("active");
  document.getElementById("side-buy").classList.remove("active");
});

document.querySelectorAll(".ot-type").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ot-type").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.type !== "market") {
      pushFeed(`${btn.dataset.type} orders aren't implemented in this demo — orders execute at market.`);
    }
  });
});

document.querySelectorAll(".quick-btn[data-r]").forEach((btn) => btn.addEventListener("click", () => setTakeProfitFromR(parseFloat(btn.dataset.r))));
document.querySelectorAll(".quick-btn[data-atr]").forEach((btn) => btn.addEventListener("click", () => setStopFromAtrMultiple(parseFloat(btn.dataset.atr))));

["risk-pct", "order-qty", "take-profit", "stop-loss"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateOrderPreview);
});

document.getElementById("place-order-btn").addEventListener("click", placeOrder);

document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const openBlock = document.getElementById("positions-thead").parentElement;
    // Simple approach: open positions vs full history both live in the Activity tab table;
    // here we just re-point the same block's content.
    if (btn.dataset.subtab === "history") {
      window.location.hash = "";
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel-view").forEach((p) => p.classList.remove("active"));
      document.querySelector('.tab[data-tab="activity"]').classList.add("active");
      document.getElementById("panel-activity").classList.add("active");
    }
  });
});

document.getElementById("run-autopilot-btn").addEventListener("click", async () => {
  const btn = document.getElementById("run-autopilot-btn");
  const out = document.getElementById("workflow-output");
  btn.disabled = true;
  btn.textContent = "Running…";
  out.hidden = false;
  out.textContent = "Evaluating confluence gate across the strategy universe…";
  try {
    const res = await fetch("/api/run", { method: "POST" });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
    pushFeed(`Autopilot run: ${data.actions_taken?.length || 0} action(s) across ${data.symbols_evaluated?.length || 0} symbols`);
    await loadState();
  } catch (err) {
    out.textContent = `Run failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run autopilot now";
  }
});

document.getElementById("lab-threshold-slider").addEventListener("input", evaluateLabThreshold);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initCharts();
loadWatchlist();
loadCandles();
loadState();
pushFeed("Terminal connected — pulling live market data.");

setInterval(loadWatchlist, 60000);
setInterval(loadState, 45000);
