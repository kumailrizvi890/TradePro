"""
TradePro - a real paper-trading demo.

Strategy engine: SMA(10)/SMA(30) crossover, evaluated against real daily
price history pulled live from Yahoo Finance's public chart API (no key
required). Every buy/sell decision is a genuine computation over that data
- nothing here is a scripted/mocked timer. All trades are simulated
(paper) and persisted to Supabase so the dashboard has real history.

Runs on Vercel as a single Flask app under @vercel/python. Routes:
  GET  /api/state  -> current portfolio snapshot + recent trades + live quotes
  POST /api/run    -> evaluate the strategy right now (manual trigger)
  GET  /api/cron   -> same evaluation, invoked by Vercel Cron on a schedule
"""

import os
import time
import traceback
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://gxjyjvqgdmtxipqpgisl.supabase.co")
SUPABASE_ANON_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4anlqdnFnZG10eGlwcXBnaXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0OTQxOTMsImV4cCI6MjEwNjA3MDE5M30.odB-vMHeyknhPZTYACLYyijgyiW1OflkTNdSlzDERTI",
)

SYMBOLS = ["AAPL", "MSFT", "TSLA", "NVDA", "SPY"]
STARTING_CASH = 100_000.0
STRATEGY_NAME = "SMA Crossover (10/30)"
POSITION_SIZE_FRACTION = 0.15  # fraction of *cash* committed to a new position
SHORT_WINDOW = 10
LONG_WINDOW = 30

REQUEST_TIMEOUT = 8


def _sb_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json",
    }


# ---------------------------------------------------------------------------
# Market data (real, live) - Yahoo Finance public chart endpoint, no API key
# ---------------------------------------------------------------------------

def fetch_closes(symbol, days=70):
    """Return a list of (timestamp, close) for `symbol`, oldest first.

    Uses Yahoo Finance's unauthenticated chart API. Returns None on any
    failure so callers can skip that symbol this run rather than crash
    the whole evaluation.
    """
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        resp = requests.get(
            url,
            params={"range": "4mo", "interval": "1d"},
            headers={"User-Agent": "Mozilla/5.0 (TradePro paper-trading demo)"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        result = data["chart"]["result"][0]
        timestamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
        pairs = [(t, c) for t, c in zip(timestamps, closes) if c is not None]
        return pairs[-days:]
    except Exception:
        return None


def sma(values, window):
    if len(values) < window:
        return None
    return sum(values[-window:]) / window


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
                "symbol": symbol,
                "side": side,
                "qty": qty,
                "price": price,
                "strategy": strategy,
                "reason": reason,
                "realized_pnl": realized_pnl,
            },
            headers=_sb_headers(),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception:
        pass


def get_recent_trades(limit=30):
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
# Strategy engine
# ---------------------------------------------------------------------------

def evaluate_strategy(source="manual trigger"):
    started = time.time()
    snapshot = get_latest_snapshot()
    cash = snapshot["cash"]
    positions = dict(snapshot["positions"])
    actions = []
    current_prices = {}
    skipped = []

    for symbol in SYMBOLS:
        pairs = fetch_closes(symbol)
        if not pairs or len(pairs) < LONG_WINDOW + 1:
            skipped.append(symbol)
            continue

        closes = [c for _, c in pairs]
        price = closes[-1]
        current_prices[symbol] = price

        short_now = sma(closes, SHORT_WINDOW)
        long_now = sma(closes, LONG_WINDOW)
        short_prev = sma(closes[:-1], SHORT_WINDOW)
        long_prev = sma(closes[:-1], LONG_WINDOW)
        if None in (short_now, long_now, short_prev, long_prev):
            skipped.append(symbol)
            continue

        holding = positions.get(symbol)

        bullish_cross = short_prev <= long_prev and short_now > long_now
        bearish_cross = short_prev >= long_prev and short_now < long_now

        if not holding and bullish_cross:
            alloc = cash * POSITION_SIZE_FRACTION
            qty = round(alloc / price, 4)
            if qty > 0 and alloc <= cash:
                cash -= qty * price
                positions[symbol] = {"qty": qty, "entry_price": price}
                reason = (
                    f"10-day SMA (${short_now:.2f}) crossed above 30-day SMA "
                    f"(${long_now:.2f})"
                )
                insert_trade(symbol, "buy", qty, price, STRATEGY_NAME, reason)
                actions.append({"symbol": symbol, "side": "buy", "qty": qty, "price": price, "reason": reason})

        elif holding and bearish_cross:
            qty = holding["qty"]
            entry_price = holding["entry_price"]
            proceeds = qty * price
            realized_pnl = proceeds - (qty * entry_price)
            cash += proceeds
            del positions[symbol]
            reason = (
                f"10-day SMA (${short_now:.2f}) crossed below 30-day SMA "
                f"(${long_now:.2f})"
            )
            insert_trade(symbol, "sell", qty, price, STRATEGY_NAME, reason, realized_pnl=realized_pnl)
            actions.append({"symbol": symbol, "side": "sell", "qty": qty, "price": price, "pnl": realized_pnl, "reason": reason})

    unrealized = 0.0
    for symbol, pos in positions.items():
        mark = current_prices.get(symbol, pos["entry_price"])
        unrealized += (mark - pos["entry_price"]) * pos["qty"]

    equity = cash + sum(
        current_prices.get(sym, pos["entry_price"]) * pos["qty"] for sym, pos in positions.items()
    )

    insert_snapshot(cash, equity, positions)

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "duration_ms": int((time.time() - started) * 1000),
        "actions_taken": actions,
        "symbols_evaluated": [s for s in SYMBOLS if s not in skipped],
        "symbols_skipped": skipped,
        "cash": round(cash, 2),
        "equity": round(equity, 2),
        "unrealized_pnl": round(unrealized, 2),
        "positions": positions,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/api/state", methods=["GET"])
def state():
    snapshot = get_latest_snapshot()
    positions = snapshot["positions"]
    current_prices = {}
    for symbol in set(SYMBOLS) | set(positions.keys()):
        pairs = fetch_closes(symbol, days=1)
        if pairs:
            current_prices[symbol] = pairs[-1][1]

    unrealized = 0.0
    position_rows = []
    for symbol, pos in positions.items():
        mark = current_prices.get(symbol, pos["entry_price"])
        pnl = (mark - pos["entry_price"]) * pos["qty"]
        unrealized += pnl
        position_rows.append({
            "symbol": symbol,
            "qty": pos["qty"],
            "entry_price": pos["entry_price"],
            "mark_price": mark,
            "unrealized_pnl": round(pnl, 2),
        })

    equity = snapshot["cash"] + sum(r["mark_price"] * r["qty"] for r in position_rows)
    trades = get_recent_trades(30)
    realized_total = sum(t["realized_pnl"] for t in trades if t.get("realized_pnl") is not None)

    return jsonify({
        "strategy": STRATEGY_NAME,
        "symbols": SYMBOLS,
        "starting_cash": STARTING_CASH,
        "cash": round(snapshot["cash"], 2),
        "equity": round(equity, 2),
        "unrealized_pnl": round(unrealized, 2),
        "realized_pnl_total": round(realized_total, 2),
        "positions": position_rows,
        "quotes": current_prices,
        "trades": trades,
    })


@app.route("/api/run", methods=["POST"])
def run():
    try:
        result = evaluate_strategy(source="manual trigger")
        return jsonify(result)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


@app.route("/api/cron", methods=["GET"])
def cron():
    try:
        result = evaluate_strategy(source="scheduled")
        return jsonify(result)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5050)
