"""Unit tests for the market-data helpers in api/market.py.

The helpers are checked by shape and signature, not by hitting the
network: the requests import is stubbed and the quote fetcher is
patched with a fake. These tests pin the exact surface the server
in api/main.py calls.
"""
import importlib.util
import inspect
import sys
import types
import unittest
from pathlib import Path

sys.modules.setdefault("requests", types.ModuleType("requests"))

_MARKET_PATH = Path(__file__).resolve().parents[1] / "api" / "market.py"
_spec = importlib.util.spec_from_file_location("tradepro_market", _MARKET_PATH)
market = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(market)

_FAKE_BAR = {"t": 1, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 10}


def _fake_quote(symbol):
    return {"symbol": symbol, "price": 100.0, "change": 1.0, "change_pct": 1.0}


class TestIntervalMap(unittest.TestCase):
    def test_monthly_interval_exists(self):
        self.assertIn("1M", market.INTERVAL_MAP)
        self.assertIn("1D", market.INTERVAL_MAP)
        self.assertIn("1W", market.INTERVAL_MAP)

    def test_watchlist_has_25_symbols(self):
        self.assertEqual(len(market.WATCHLIST_SYMBOLS), 25)


class TestFetchDaily(unittest.TestCase):
    def test_fetch_daily_takes_days(self):
        params = inspect.signature(market.fetch_daily).parameters
        self.assertIn("days", params)

    def test_fetch_daily_parallel_takes_days(self):
        params = inspect.signature(market.fetch_daily_parallel).parameters
        self.assertIn("days", params)

    def test_fetch_daily_parallel_returns_dict_keyed_by_symbol(self):
        original = market.fetch_daily
        market.fetch_daily = lambda symbol, days=260: [_FAKE_BAR][:days]
        try:
            result = market.fetch_daily_parallel(["NVDA"])
        finally:
            market.fetch_daily = original
        self.assertIsInstance(result, dict)
        self.assertIn("NVDA", result)


class TestFetchQuotesParallel(unittest.TestCase):
    def test_returns_dict_keyed_by_symbol(self):
        original = market.fetch_quote
        market.fetch_quote = _fake_quote
        try:
            result = market.fetch_quotes_parallel(["NVDA", "BTC-USD"])
        finally:
            market.fetch_quote = original
        self.assertIsInstance(result, dict)
        self.assertEqual(result["NVDA"]["price"], 100.0)
        self.assertEqual(result["BTC-USD"]["price"], 100.0)


if __name__ == "__main__":
    unittest.main()
