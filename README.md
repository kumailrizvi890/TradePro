# TradePro

TradePro is an algorithmic trading terminal — a real, working demo that charts live market data, scores trade setups, and runs paper trading, with trades and equity snapshots persisted to Supabase.

## What it does

- **25-symbol watchlist** covering crypto and US equities, with a terminal-style interface in `public/`.
- **Real candlestick charts** built with TradingView's lightweight-charts library, with SMA overlays, a volume pane, and a live RSI subplot.
- **Technical analysis in Python**: the Flask backend in `api/` computes indicators (including SMA and RSI) and an 8-factor technical confluence gate that scores setups before a trade is suggested.
- **Manual order ticket** with risk-based position sizing using ATR-based stops.
- **SMA-crossover paper-trading engine** for backtesting-style simulated trades.
- **Market data from Yahoo Finance**, including daily closes for symbols such as AAPL, MSFT, TSLA, NVDA, and SPY.
- **Persistence in Supabase**: trades and equity snapshots are stored so a portfolio can be reviewed across sessions.

## Tech stack

- Backend: Python, Flask (`flask==3.0.3`), `requests` — see `requirements.txt`
- Frontend: HTML/CSS/JavaScript in `public/`, TradingView lightweight-charts
- Data: Yahoo Finance market data, Supabase for persistence
- Deployment: Vercel (`vercel.json`)

## How to run it

```bash
pip install -r requirements.txt
```

Deploy the repository on Vercel (the included `vercel.json` wires up the Flask backend in `api/` and the static terminal in `public/`), or run the Flask app locally from `api/` after installing the requirements.

## Status

Working demo: charting, confluence scoring, manual orders, and SMA-crossover paper trading are implemented. This is a paper-trading demo, not a live brokerage integration.
