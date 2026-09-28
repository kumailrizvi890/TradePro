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
}


def fetch_ohlc(symbol, timeframe="1D"):
    """Return a list of {t,o,h,l,c,v} bars, oldest first, or None on failure."""
    cfg = INTERVAL_MAP.get(timeframe, INTERVAL_MAP["1D"])
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        resp = requests.get(
            url,
            params={"range": cfg["range"], "interval": cfg["interval"]},
            headers=HEADERS,
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        result = data["chart"]["result"][0]
        ts = result["timestamp"]
        quote = result["indicators"]["quote"][0]
        bars = []
        for i, t in enumerate(ts):
            o, h, l, c, v = (quote["open"][i], quote["high"][i], quote["low"][i],
                              quote["close"][i], quote["volume"][i])
            if None in (o, h, l, c):
                continue
            bars.append({"t": t * 1000, "o": o, "h": h, "l": l, "c": c, "v": v or 0})
        if timeframe == "4H":
            bars = _resample(bars, 4)
        return bars
    except Exception:
        return None


def _resample(bars, factor):
    out = []
    for i in range(0, len(bars) - factor + 1, factor):
        chunk = bars[i:i + factor]
        out.append({
            "t": chunk[0]["t"],
            "o": chunk[0]["o"],
            "h": max(b["h"] for b in chunk),
            "l": min(b["l"] for b in chunk),
            "c": chunk[-1]["c"],
            "v": sum(b["v"] for b in chunk),
        })
    return out


def fetch_daily(symbol, days=260):
    """Daily bars used for indicator/signal computation, independent of
    whatever timeframe the chart itself is displaying."""
    bars = fetch_ohlc(symbol, "1D")
    if not bars:
        return None
    return bars[-days:]


def fetch_quote(symbol):
    """Return {symbol, price, change_pct} from the last two daily closes."""
    bars = fetch_ohlc(symbol, "1D")
    if not bars or len(bars) < 2:
        return None
    price = bars[-1]["c"]
    prev = bars[-2]["c"]
    change_pct = (price - prev) / prev * 100 if prev else 0.0
    return {"symbol": symbol, "price": price, "change_pct": round(change_pct, 2)}


def fetch_quotes_parallel(symbols, max_workers=10):
    """Fetch several quotes concurrently. Returns {symbol: quote-or-None}."""
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(fetch_quote, s): s for s in symbols}
        for fut in concurrent.futures.as_completed(futures):
            symbol = futures[fut]
            try:
                out[symbol] = fut.result()
            except Exception:
                out[symbol] = None
    return out


def fetch_daily_parallel(symbols, days=260, max_workers=8):
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(fetch_daily, s, days): s for s in symbols}
        for fut in concurrent.futures.as_completed(futures):
            symbol = futures[fut]
            try:
                out[symbol] = fut.result()
            except Exception:
                out[symbol] = None
    return out
