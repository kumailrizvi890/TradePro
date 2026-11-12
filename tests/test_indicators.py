"""Unit tests for the indicator math in api/indicators.py.

These run offline against synthetic price series: they check the
formulas, not live market data.
"""
import importlib.util
import unittest
from pathlib import Path

_INDICATORS_PATH = Path(__file__).resolve().parents[1] / "api" / "indicators.py"
_spec = importlib.util.spec_from_file_location("tradepro_indicators", _INDICATORS_PATH)
indicators = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(indicators)


def _bars(n, start=100.0, step=0.4):
    closes = [start + i * step for i in range(n)]
    return [{"o": c - 0.5, "h": c + 1.0, "l": c - 1.0, "c": c, "v": 1000 + i * 10} for i, c in enumerate(closes)]


class TestSma(unittest.TestCase):
    def test_sma_last_window(self):
        self.assertEqual(indicators.sma([1, 2, 3, 4], 2), 3.5)

    def test_sma_too_short_is_none(self):
        self.assertIsNone(indicators.sma([1], 5))
        self.assertIsNone(indicators.sma([], 3))

    def test_sma_series_length_and_values(self):
        series = indicators.sma_series(list(range(1, 11)), 3)
        self.assertEqual(len(series), 8)
        self.assertEqual(series[0], 2.0)
        self.assertEqual(series[-1], 9.0)


class TestRsi(unittest.TestCase):
    def test_rsi_all_gains_is_100(self):
        self.assertEqual(indicators.rsi([100 + i for i in range(20)]), 100.0)

    def test_rsi_stays_in_range(self):
        closes = [100, 102, 101, 105, 103, 107, 104, 108, 106, 110, 108, 112, 111, 115, 113, 117]
        value = indicators.rsi(closes)
        self.assertIsNotNone(value)
        self.assertGreaterEqual(value, 0)
        self.assertLessEqual(value, 100)


class TestMacd(unittest.TestCase):
    def test_macd_returns_lines(self):
        closes = [100 + i * 0.3 for i in range(60)]
        result = indicators.macd(closes)
        self.assertIsNotNone(result)
        self.assertIn("macd", result)
        self.assertIn("signal", result)
        self.assertIn("hist", result)


class TestComputeSignal(unittest.TestCase):
    def test_trending_series_shape(self):
        bars = _bars(120)
        signal = indicators.compute_signal(
            [b["h"] for b in bars],
            [b["l"] for b in bars],
            [b["c"] for b in bars],
            [b["v"] for b in bars],
        )
        self.assertIsNotNone(signal)
        self.assertIn("passed", signal)
        self.assertIn("total", signal)
        self.assertIn("regime", signal)
        self.assertGreaterEqual(signal["passed"], 0)
        self.assertLessEqual(signal["passed"], signal["total"])
        self.assertGreaterEqual(signal["rsi"], 0)
        self.assertLessEqual(signal["rsi"], 100)


if __name__ == "__main__":
    unittest.main()
