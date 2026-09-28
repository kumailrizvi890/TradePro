"""
TradePro - a real algorithmic paper-trading terminal.

Every number on this dashboard is computed from live market data pulled
from Yahoo Finance's public chart API (no key required): a 25-symbol
watchlist (crypto + US equities), real OHLCV candles per timeframe, and
an 8-factor technical confluence gate (RSI, momentum, volatility, volume,
ADX, EMA fast/slow, MACD) computed fresh on every request - nothing here
is scripted or faked. The autopilot strategy only opens a position when
at least 7 of those 8 checks agree, sizes stops off real ATR, and exits
on a real stop-loss, take-profit, or regime flip. The order ticket lets
a visitor place a manual paper trade with real risk-based position
sizing. All trades and equity snapshots persist to Supabase so the
dashboard has genuine history across runs. This is a paper-trading demo
- no real money, no live brokerage.
"""

import os
import time
import traceback
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify, request

import indicators as ind
import market as mkt

app = Flask(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://gxjyjvqgdmtxipqpgisl.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4anlqdnFnZG10eGlwcXBnaXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTQxOTMsImV4cCI6MjEwNjA3MDE5M30.odB-vMHeyknhPZTYACLYyijgyiW1OflkTNdSlzDERTI",
)

STARTING_CASH = 100_000.0
STRATEGY_NAME = "Confluence Gate (7/8)"
POSITION_SIZE_FRACTION = 0.12
CONFLUENCE_ENTRY = 7
CONFLUENCE_EXIT = 2
ATR_STOP_MULT = 1.5
DEFAULT_R_MULTIPLE = 2.0
FOCUS_SYMBOL_DEFAULT = "BTC-USD"

REQUEST_TIMEOUT = 8
BUILD_SHA = (os.environ.get("VERCEL_GIT_COMMIT_SHA") or "dev")[:10]


def _sb_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Supabase persistence
# ---------------------------------------------------------------------------

def get_latest_snapshot():
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/tp_snapshots",
            params={"select": "*", "order": "created_at.desc", "limit": 1},
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        if rows:
            row = rows[0]
            return {
                "cash": float(row["cash"]),
                "equity": float(row["equity"]),
                "positions": row["positions"] or {},
            }
    except Exception:
        pass
    return {"cash": STARTING_CASH, "equity": STARTING_CASH, "positions": {}}


def get_first_snapshot_today():
    start_of_day = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/tp_snapshots",
            params={"select": "*", "created_at": f"gte.{start_of_day}", "order": "created_at.asc", "limit": 1},
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        if rows:
            return float(rows[0]["equity"])
    except Exception:
        pass
    return None


def insert_snapshot(cash, equity, positions):
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/tp_snapshots",
            json={"cash": cash, "equity": equity, "positions": positions},
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        pass


def insert_trade(symbol, side, qty, price, strategy, reason, realized_pnl=None):
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/tp_trades",
            json={
                "symbol": symbol, "side": side, "qty": qty, "price": price,
                "strategy": strategy, "reason": reason, "realized_pnl": realized_pnl,
            },
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        pass


def get_recent_trades(limit=40):
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/tp_trades",
            params={"select": "*", "order": "created_at.desc", "limit": limit},
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Strategy engine - real confluence gate, real ATR-based risk management
# ---------------------------------------------------------------------------

def _atr(bars, period=14):
    highs = [b["h"] for b in bars]
    lows = [b["l"] for b in bars]
    closes = [b["c"] for b in bars]
    trs = []
    for i in range(1, len(closes)):
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    if len(trs) < period:
        return None
    return sum(trs[-period:]) / period


def evaluate_autopilot(source="manual trigger"):
    started = time.time()
    snapshot = get_latest_snapshot()
    cash = snapshot["cash"]
    positions = dict(snapshot["positions"])
    actions = []
    signals_by_symbol = {}

    daily_data = mkt.fetch_daily_parallel(mkt.STRATEGY_SYMBOLS, days=260)

    for symbol in mkt.STRATEGY_SYMBOLS:
        bars = daily_data.get(symbol)
        if not bars or len(bars) < 60:
            continue
        highs = [b["h"] for b in bars]
        lows = [b["l"] for b in bars]
        closes = [b["c"] for b in bars]
        volumes = [b["v"] for b in bars]
        signal = ind.compute_signal(highs, lows, closes, volumes)
        if not signal:
            continue
        signals_by_symbol[symbol] = signal
        price = signal["close"]
        holding = positions.get(symbol)
        atr_val = _atr(bars) or (price * 0.02)

        if holding:
            stop = holding.get("stop_loss")
            tp = holding.get("take_profit")
            exit_reason = None
            if stop is not None and price <= stop:
                exit_reason = "stop loss"
            elif tp is not None and price >= tp:
                exit_reason = "take profit"
            elif signal["passed"] <= CONFLUENCE_EXIT:
                exit_reason = "regime flip"
            if exit_reason:
                qty = holding["qty"]
                proceeds = qty * price
                realized_pnl = proceeds - (qty * holding["entry_price"])
                cash += proceeds
                del positions[symbol]
                reason = f"{exit_reason} @ ${price:.2f} (confluence {signal['passed']}/{signal['total']}, regime {signal['regime']})"
                insert_trade(symbol, "sell", qty, price, STRATEGY_NAME, reason, realized_pnl=realized_pnl)
                actions.append({"symbol": symbol, "side": "sell", "qty": qty, "price": price, "pnl": realized_pnl, "reason": reason})

        elif signal["passed"] >= CONFLUENCE_ENTRY:
            alloc = cash * POSITION_SIZE_FRACTION
            stop_loss = price - atr_val * ATR_STOP_MULT
            risk_distance = price - stop_loss
            take_profit = price + risk_distance * DEFAULT_R_MULTIPLE
            qty = round(alloc / price, 6)
            if qty > 0 and alloc <= cash:
                cash -= qty * price
                positions[symbol] = {
                    "qty": qty, "entry_price": price,
                    "stop_loss": round(stop_loss, 4), "take_profit": round(take_profit, 4),
                }
                reason = f"confluence {signal['passed']}/{signal['total']} passed ({signal['regime']}) - stop ${stop_loss:.2f}, target ${take_profit:.2f}"
                insert_trade(symbol, "buy", qty, price, STRATEGY_NAME, reason)
                actions.append({"symbol": symbol, "side": "buy", "qty": qty, "price": price, "reason": reason})

    equity = cash + sum(
        (signals_by_symbol.get(sym, {}).get("close") or pos["entry_price"]) * pos["qty"]
        for sym, pos in positions.items()
    )
    insert_snapshot(cash, equity, positions)

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "duration_ms": int((time.time() - started) * 1000),
        "actions_taken": actions,
        "symbols_evaluated": list(signals_by_symbol.keys()),
        "cash": round(cash, 2),
        "equity": round(equity, 2),
        "positions": positions,
        "signals": signals_by_symbol,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/api/watchlist", methods=["GET"])
def watchlist():
    quotes = mkt.fetch_quotes_parallel(mkt.WATCHLIST_SYMBOLS)
    crypto = [quotes[s] for s in mkt.CRYPTO_SYMBOLS if quotes.get(s)]
    equities = [quotes[s] for s in mkt.EQUITY_SYMBOLS if quotes.get(s)]
    return jsonify({"crypto": crypto, "equities": equities, "count": len(crypto) + len(equities)})


@app.route("/api/candles", methods=["GET"])
def candles():
    symbol = request.args.get("symbol", FOCUS_SYMBOL_DEFAULT)
    timeframe = request.args.get("timeframe", "1H")
    bars = mkt.fetch_ohlc(symbol, timeframe)
    if not bars:
        return jsonify({"error": f"couldn't fetch live data for {symbol}"}), 502

    closes = [b["c"] for b in bars]
    sma_fast = ind.sma_series(closes, 10)
    sma_slow = ind.sma_series(closes, 30)
    fast_offset = len(closes) - len(sma_fast)
    slow_offset = len(closes) - len(sma_slow)

    daily_bars = mkt.fetch_daily(symbol, days=260)
    signal = None
    if daily_bars and len(daily_bars) >= 60:
        signal = ind.compute_signal(
            [b["h"] for b in daily_bars], [b["l"] for b in daily_bars],
            [b["c"] for b in daily_bars], [b["v"] for b in daily_bars],
        )

    latest = bars[-1]
    prev = bars[-2] if len(bars) > 1 else latest
    change_pct = (latest["c"] - prev["c"]) / prev["c"] * 100 if prev["c"] else 0.0

    return jsonify({
        "symbol": symbol,
        "timeframe": timeframe,
        "bars": bars,
        "sma_fast": [{"t": bars[fast_offset + i]["t"], "v": v} for i, v in enumerate(sma_fast)],
        "sma_slow": [{"t": bars[slow_offset + i]["t"], "v": v} for i, v in enumerate(sma_slow)],
        "price": latest["c"],
        "change_pct": round(change_pct, 2),
        "signal": signal,
    })


@app.route("/api/order", methods=["POST"])
def place_order():
    body = request.get_json(force=True, silent=True) or {}
    symbol = body.get("symbol")
    side = body.get("side")
    risk_pct = float(body.get("risk_pct") or 1)
    quantity = body.get("quantity", "auto")
    take_profit_in = body.get("take_profit")
    stop_loss_in = body.get("stop_loss")

    if not symbol or side not in ("buy", "sell"):
        return jsonify({"error": "symbol and side ('buy' or 'sell') are required"}), 400

    daily_bars = mkt.fetch_daily(symbol, days=120)
    if not daily_bars or len(daily_bars) < 20:
        return jsonify({"error": f"couldn't fetch live data for {symbol}"}), 502

    price = daily_bars[-1]["c"]
    atr_val = _atr(daily_bars) or (price * 0.02)

    snapshot = get_latest_snapshot()
    cash = snapshot["cash"]
    positions = dict(snapshot["positions"])
    equity = cash + sum(p["entry_price"] * p["qty"] for p in positions.values())

    if side == "sell":
        holding = positions.get(symbol)
        if not holding:
            return jsonify({"error": f"No open position in {symbol} to sell - short selling isn't supported in this demo"}), 400
        qty = holding["qty"]
        proceeds = qty * price
        realized_pnl = proceeds - (qty * holding["entry_price"])
        cash += proceeds
        del positions[symbol]
        reason = f"manual order - closed at ${price:.2f}"
        insert_trade(symbol, "sell", qty, price, "Manual order", reason, realized_pnl=realized_pnl)
        equity_after = cash + sum(p["entry_price"] * p["qty"] for p in positions.values())
        insert_snapshot(cash, equity_after, positions)
        return jsonify({"symbol": symbol, "side": "sell", "qty": qty, "price": price, "realized_pnl": round(realized_pnl, 2), "cash": round(cash, 2), "equity": round(equity_after, 2)})

    # side == "buy"
    stop_loss = float(stop_loss_in) if stop_loss_in not in (None, "") else round(price - atr_val * ATR_STOP_MULT, 4)
    take_profit = float(take_profit_in) if take_profit_in not in (None, "") else round(price + (price - stop_loss) * DEFAULT_R_MULTIPLE, 4)
    risk_distance = max(price - stop_loss, 0.0001)

    if quantity in ("auto", "", None):
        risk_amount = equity * (risk_pct / 100)
        qty = round(risk_amount / risk_distance, 6)
    else:
        qty = round(float(quantity), 6)

    cost = qty * price
    if cost > cash:
        qty = round(cash / price, 6)
        cost = qty * price

    if qty <= 0:
        return jsonify({"error": "computed quantity is zero - not enough cash or risk % too small"}), 400

    cash -= cost
    positions[symbol] = {"qty": qty, "entry_price": price, "stop_loss": stop_loss, "take_profit": take_profit}
    reason = f"manual order - risk {risk_pct}% (${round(equity * risk_pct / 100, 2)}), stop ${stop_loss:.2f}, target ${take_profit:.2f}"
    insert_trade(symbol, "buy", qty, price, "Manual order", reason)
    equity_after = cash + sum(
        (p["entry_price"] if s != symbol else price) * p["qty"] for s, p in positions.items()
    )
    insert_snapshot(cash, equity_after, positions)
    return jsonify({
        "symbol": symbol, "side": "buy", "qty": qty, "price": price,
        "stop_loss": stop_loss, "take_profit": take_profit,
        "cash": round(cash, 2), "equity": round(equity_after, 2),
    })


@app.route("/api/state", methods=["GET"])
def state():
    focus_symbol = request.args.get("focus", FOCUS_SYMBOL_DEFAULT)
    snapshot = get_latest_snapshot()
    positions = snapshot["positions"]

    mark_prices = {}
    for symbol in positions:
        q = mkt.fetch_quote(symbol)
        if q:
            mark_prices[symbol] = q["price"]

    unrealized = 0.0
    position_rows = []
    for symbol, pos in positions.items():
        mark = mark_prices.get(symbol, pos["entry_price"])
        pnl = (mark - pos["entry_price"]) * pos["qty"]
        unrealized += pnl
        position_rows.append({
            "symbol": symbol, "qty": pos["qty"], "entry_price": pos["entry_price"],
            "mark_price": mark, "unrealized_pnl": round(pnl, 2),
            "stop_loss": pos.get("stop_loss"), "take_profit": pos.get("take_profit"),
        })

    equity = snapshot["cash"] + sum(r["mark_price"] * r["qty"] for r in position_rows)
    trades = get_recent_trades(40)
    realized_total = sum(t["realized_pnl"] for t in trades if t.get("realized_pnl") is not None)
    closed = [t for t in trades if t.get("realized_pnl") is not None]
    wins = [t for t in closed if t["realized_pnl"] > 0]
    win_rate = round(len(wins) / len(closed) * 100, 1) if closed else None

    start_equity = get_first_snapshot_today()
    day_pnl = round(equity - start_equity, 2) if start_equity is not None else 0.0

    focus_daily = mkt.fetch_daily(focus_symbol, days=260)
    signal = None
    live_data = False
    if focus_daily and len(focus_daily) >= 60:
        live_data = True
        signal = ind.compute_signal(
            [b["h"] for b in focus_daily], [b["l"] for b in focus_daily],
            [b["c"] for b in focus_daily], [b["v"] for b in focus_daily],
        )
    readiness = round(signal["passed"] / signal["total"] * 100) if signal else 0

    return jsonify({
        "strategy": STRATEGY_NAME,
        "strategy_universe": mkt.STRATEGY_SYMBOLS,
        "starting_cash": STARTING_CASH,
        "cash": round(snapshot["cash"], 2),
        "equity": round(equity, 2),
        "day_pnl": day_pnl,
        "unrealized_pnl": round(unrealized, 2),
        "realized_pnl_total": round(realized_total, 2),
        "open_count": len(position_rows),
        "closed_count": len(closed),
        "win_rate": win_rate,
        "positions": position_rows,
        "trades": trades,
        "focus_symbol": focus_symbol,
        "signal": signal,
        "readiness": readiness,
        "confluence_entry": CONFLUENCE_ENTRY,
        "live_data": live_data,
        "autopilot": True,
        "build": BUILD_SHA,
    })


@app.route("/api/run", methods=["POST"])
def run():
    try:
        return jsonify(evaluate_autopilot(source="manual trigger"))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/cron", methods=["GET"])
def cron():
    try:
        return jsonify(evaluate_autopilot(source="scheduled"))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5050)
