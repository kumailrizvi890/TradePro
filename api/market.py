"""
Live market data via Yahoo Finance's public chart API - no key required.
Every number that reaches the frontend comes from a real request here.
"""

import concurrent.futures

import requests

REQUEST_TIMEOUT = 8
HEADERS = {"User-Agent": "Mozilla/5.0 (TradePro paper-trading demo)"}

CRYPTO_SYMBOLS = [
    "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD",
    "ADA-USD", "AVAX-USD", "DOGE-USD", "LINK-USD", "LTC-USD",
]
EQUITY_SYMBOLS = [
    "NVDA", "TSLA", "AAPL", "MSFT", "META", "AMD", "AMZN",
    "GOOGL", "PLTR", "COIN", "AVGO", "NFLX", "SPY", "QQQ", "MSTR",
]
WATCHLIST_SYMBOLS = CRYPTO_SYMBOLS + EQUITY_SYMBOLS

# Curated universe the autopilot strategy actually trades - kept smaller so
# a run finishes comfortably inside the function's time budget.
STRATEGY_SYMBOLS = ["BTC-USD", "ETH-USD", "NVDA", "TSLA", "AAPL", "MSFT", "SPY", "COIN"]

INTERVAL_MAP = {
    "15m": {"interval": "15m", "range": "5d"},
    "1H": {"interval": "60m", "range": "1mo"},
    "4H": {"interval": "60m", "range": "3mo"},  # resampled x4 after fetch
    "1D": {"interval": "1d", "range": "6mo"},
    "1W": {"interval": "1wk", "range": "2y"},
    "1M": {"interval": "1mo", "range": "5y"},
}


def fetch_ohlc(symbol, timeframe="1D"):
    """Return a list of {t,o,h,l,c,v} bars, oldest first, or None on failure."""
    m = INTERVAL_MAP.get(timeframe, INTERVAL_MAP["1D"])
    params = {
        "interval": m["interval"],
        "range": m["range"],
        "includePrePost": "false",
        "events": "div,split",
    }
    r = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", params=params, headers=HEADERS, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    bars = [
        {
            "t": t * 1000,
            "o": o,
            "h": h,
            "l": l,
            "c": c,
            "v": v or 0,
        }
        for t, o, h, l, c, v in zip(ts, q["open"], q["high"], q["low"], q["close"], q.get("volume") or [0] * len(ts))
        if o is not None and c is not None
    ]
    if timeframe == "4H":
        agg = []
        for i in range(0, len(bars), 4):
            chunk = bars[i:i + 4]
            if len(chunk) < 4 and len(bars) - i < 2:
                agg.extend(chunk)
                continue
            agg.append({
                "t": chunk[0]["t"],
                "o": chunk[0]["o"],
                "h": max(c["h"] for c in chunk),
                "l": min(c["l"] for c in chunk),
                "c": chunk[-1]["c"],
                "v": sum(c["v"] for c in chunk),
            })
        bars = agg
    return bars


def fetch_quote(symbol):
    """Return latest quote for *symbol* with both magnitudes of change."""
    daily = fetch_ohlc(symbol, "1D")
    if not daily or len(daily) < 2:
        return None
    last, prev = daily[-1], daily[-2]
    is_crypto = symbol.endswith("-USD")
    if is_crypto:
        price = last["c"]
        chg = price - prev["c"]
        chg_pct = (chg / prev["c"]) * 100 if prev["c"] else None
    else:
        price = last["c"]
        chg = price - prev["c"]
        chg_pct = (chg / prev["c"]) * 100 if prev["c"] else None
    return {
        "symbol": symbol,
        "price": round(price, 6),
        "change": round(chg, 6),
        "change_pct": round(chg_pct, 4) if chg_pct is not None else None,
    }


def fetch_quotes(symbols):
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        return sorted(
            (q for q in ex.map(fetch_quote, symbols) if q),
            key=lambda q: WATCHLIST_SYMBOLS.index(q["symbol"]) if q["symbol"] in WATCHLIST_SYMBOLS else 99,
        )


def fetch_daily(symbol):
    """Return daily OHLC bars used by the strategy engine."""
    return fetch_ohlc(symbol, "1D")
