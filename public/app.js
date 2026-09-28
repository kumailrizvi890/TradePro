const fmtMoney = (n) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtSigned = (n) => {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtMoney(n)}`;
};

const pnlClass = (n) => (n > 0 ? "positive" : n < 0 ? "negative" : "");

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function loadState() {
  const runStatus = document.getElementById("run-status");
  try {
    const res = await fetch("/api/state");
    const data = await res.json();

    setStat("stat-equity", fmtMoney(data.equity));
    setStat("stat-cash", fmtMoney(data.cash));
    setStat("stat-unrealized", fmtSigned(data.unrealized_pnl), pnlClass(data.unrealized_pnl));
    setStat("stat-realized", fmtSigned(data.realized_pnl_total), pnlClass(data.realized_pnl_total));

    renderPositions(data.positions || []);
    renderTrades(data.trades || []);
    runStatus.textContent = "";
  } catch (err) {
    runStatus.textContent = `Couldn't load state: ${err.message}`;
  }
}

function setStat(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "stat-value" + (cls ? " " + cls : "");
}

function renderPositions(positions) {
  const body = document.getElementById("positions-body");
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No open positions.</td></tr>`;
    return;
  }
  body.innerHTML = positions
    .map(
      (p) => `
    <tr>
      <td>${p.symbol}</td>
      <td>${p.qty}</td>
      <td>${fmtMoney(p.entry_price)}</td>
      <td>${fmtMoney(p.mark_price)}</td>
      <td class="${pnlClass(p.unrealized_pnl) === "positive" ? "pnl-pos" : pnlClass(p.unrealized_pnl) === "negative" ? "pnl-neg" : ""}">${fmtSigned(p.unrealized_pnl)}</td>
    </tr>`
    )
    .join("");
}

function renderTrades(trades) {
  const body = document.getElementById("trades-body");
  if (!trades.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No trades yet — evaluate the strategy to generate the first signal.</td></tr>`;
    return;
  }
  body.innerHTML = trades
    .map(
      (t) => `
    <tr>
      <td>${timeAgo(t.created_at)}</td>
      <td>${t.symbol}</td>
      <td class="side-${t.side}">${t.side.toUpperCase()}</td>
      <td>${t.qty}</td>
      <td>${fmtMoney(t.price)}</td>
      <td class="${pnlClass(t.realized_pnl) === "positive" ? "pnl-pos" : pnlClass(t.realized_pnl) === "negative" ? "pnl-neg" : ""}">${t.realized_pnl != null ? fmtSigned(t.realized_pnl) : "—"}</td>
      <td>${t.reason || ""}</td>
    </tr>`
    )
    .join("");
}

async function runStrategy() {
  const btn = document.getElementById("run-btn");
  const runStatus = document.getElementById("run-status");
  const outputSection = document.getElementById("output-section");
  const outputBody = document.getElementById("output-body");

  btn.disabled = true;
  btn.textContent = "Evaluating…";
  runStatus.textContent = "Fetching live prices and computing SMA signals…";

  try {
    const res = await fetch("/api/run", { method: "POST" });
    const data = await res.json();
    outputSection.hidden = false;
    outputBody.textContent = JSON.stringify(data, null, 2);
    if (data.actions_taken && data.actions_taken.length) {
      runStatus.textContent = `${data.actions_taken.length} trade(s) executed.`;
    } else {
      runStatus.textContent = "No crossover signal this run — no trades taken.";
    }
    await loadState();
  } catch (err) {
    runStatus.textContent = `Run failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Evaluate strategy now";
  }
}

document.getElementById("run-btn").addEventListener("click", runStrategy);
document.getElementById("refresh-btn").addEventListener("click", loadState);

loadState();
setInterval(loadState, 60000);
