"""
Real technical-indicator math, computed from actual OHLCV series.
No fabricated numbers - every value here is a genuine calculation.
"""


def sma(values, period):
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def sma_series(values, period):
    if len(values) < period:
        return []
    out = []
    for i in range(period, len(values) + 1):
        out.append(sum(values[i - period:i]) / period)
    return out


def ema_series(values, period):
    if len(values) < period:
        return []
    k = 2 / (period + 1)
    out = [sum(values[:period]) / period]
    for v in values[period:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def ema_last(values, period):
    s = ema_series(values, period)
    return s[-1] if s else None


def rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [d if d > 0 else 0.0 for d in deltas]
    losses = [-d if d < 0 else 0.0 for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow + signal:
        return None
    fast_s = ema_series(closes, fast)
    slow_s = ema_series(closes, slow)
    offset = slow - fast
    if offset < 0 or len(fast_s) <= offset:
        return None
    macd_line = [fast_s[i + offset] - slow_s[i] for i in range(len(slow_s))]
    if len(macd_line) < signal:
        return None
    signal_s = ema_series(macd_line, signal)
    if not signal_s:
        return None
    macd_val = macd_line[-1]
    signal_val = signal_s[-1]
    return {"macd": macd_val, "signal": signal_val, "hist": macd_val - signal_val}


def _wilder_smooth(values, period):
    if len(values) < period:
        return []
    out = [sum(values[:period])]
    for v in values[period:]:
        out.append(out[-1] - out[-1] / period + v)
    return out


def adx(highs, lows, closes, period=14):
    n = len(closes)
    if n < period * 2:
        return None
    trs, plus_dm, minus_dm = [], [], []
    for i in range(1, n):
        high, low, prev_close = highs[i], lows[i], closes[i - 1]
        prev_high, prev_low = highs[i - 1], lows[i - 1]
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr)
        up_move = high - prev_high
        down_move = prev_low - low
        plus_dm.append(up_move if (up_move > down_move and up_move > 0) else 0.0)
        minus_dm.append(down_move if (down_move > up_move and down_move > 0) else 0.0)

    atr_s = _wilder_smooth(trs, period)
    plus_s = _wilder_smooth(plus_dm, period)
    minus_s = _wilder_smooth(minus_dm, period)
    if not atr_s or not plus_s or not minus_s:
        return None

    plus_di = [100 * (p / a) if a else 0.0 for p, a in zip(plus_s, atr_s)]
    minus_di = [100 * (m / a) if a else 0.0 for m, a in zip(minus_s, atr_s)]
    dx = [100 * abs(p - m) / (p + m) if (p + m) else 0.0 for p, m in zip(plus_di, minus_di)]
    if len(dx) < period:
        return None
    adx_s = [sum(dx[:period]) / period]
    for d in dx[period:]:
        adx_s.append((adx_s[-1] * (period - 1) + d) / period)
    return adx_s[-1]


def volatility_pct(closes, window=20):
    if len(closes) < window + 1:
        return None
    rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(len(closes) - window, len(closes))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / len(rets)
    return (var ** 0.5) * 100


def volume_ratio(volumes, window=20):
    if len(volumes) < window + 1:
        return None
    avg = sum(volumes[-window - 1:-1]) / window
    if avg == 0:
        return None
    return volumes[-1] / avg


def momentum_pct(closes):
    if len(closes) < 2:
        return None
    prev = closes[-2]
    if prev == 0:
        return None
    return (closes[-1] - prev) / prev * 100


def compute_signal(highs, lows, closes, volumes):
    """Run the full 8-check confluence gate against a daily OHLCV series.

    Returns None if there isn't enough history yet, otherwise a dict with
    every raw indicator value, the pass/fail per check, how many passed,
    and a simple regime classification - all genuinely computed, nothing
    hardcoded.
    """
    if len(closes) < 60:
        return None

    close = closes[-1]
    rsi_val = rsi(closes, 14)
    mom = momentum_pct(closes)
    vol = volatility_pct(closes, 20)
    vr = volume_ratio(volumes, 20)
    adx_val = adx(highs, lows, closes, 14)
    ema_fast = ema_last(closes, 10)
    ema_slow = ema_last(closes, 30)
    sma50 = sma(closes, 50)
    macd_val = macd(closes)

    if None in (rsi_val, mom, vol, vr, adx_val, ema_fast, ema_slow, sma50, macd_val):
        return None

    ema_fast_pct = (close - ema_fast) / ema_fast * 100
    ema_slow_pct = (close - ema_slow) / ema_slow * 100

    checks = {
        "RSI": rsi_val < 45,
        "Momentum": mom > 0,
        "Volatility": 0.05 <= vol <= 4.0,
        "Volume": vr > 1.0,
        "ADX": adx_val > 20,
        "EMA Fast": close > ema_fast,
        "EMA Slow": close > ema_slow,
        "MACD": macd_val["macd"] > macd_val["signal"],
    }
    passed = sum(1 for v in checks.values() if v)

    if adx_val > 25:
        regime = "BULL_RUN" if close > sma50 else "BEAR_RUN"
    elif adx_val < 15:
        regime = "CHOP"
    else:
        regime = "RECOVERY"

    return {
        "rsi": round(rsi_val, 1),
        "momentum_pct": round(mom, 2),
        "volatility_pct": round(vol, 2),
        "volume_ratio": round(vr, 2),
        "adx": round(adx_val, 1),
        "ema_fast_pct": round(ema_fast_pct, 1),
        "ema_slow_pct": round(ema_slow_pct, 1),
        "macd": round(macd_val["macd"], 1),
        "macd_signal": round(macd_val["signal"], 1),
        "checks": checks,
        "passed": passed,
        "total": len(checks),
        "regime": regime,
        "close": close,
    }
