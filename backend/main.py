# backend/main.py
import os
import math
from datetime import datetime
from typing import List, Optional, Dict, Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from providers import OptionContract, resolve_get_option_chain

# ---- Load environment variables for strategy defaults ----
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / "strategy_defaults.env")

ROLLING_DEFAULTS = {
    "delta_min": float(os.getenv("ROLLING_DELTA_MIN", "0.20")),
    "delta_max": float(os.getenv("ROLLING_DELTA_MAX", "0.25")),
    "band_window": float(os.getenv("ROLLING_BAND_WINDOW", "0.00")),
    "credit_min_pct": float(os.getenv("ROLLING_CREDIT_MIN_PCT", "0.006")),
    "credit_max_pct": float(os.getenv("ROLLING_CREDIT_MAX_PCT", "0.008")),
}

RISK_FREE_RATE = 0.04  # 4% annual risk-free rate (approx)

# ---- Resolve provider at startup ----
get_option_chain, DATA_PROVIDER = resolve_get_option_chain()

# ---- Create FastAPI app ----
app = FastAPI(
    title="Put Opportunity Finder backend",
    description=(
        "Backend for rolling short PUT strategy helper.\n"
        f"Active data provider: {DATA_PROVIDER}"
    ),
    version="2.0.0",
)

# ---- CORS ----
origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://put-oportunity-finder.netlify.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {
        "status": "ok",
        "message": "Put Opportunity Finder backend is running",
        "data_provider": DATA_PROVIDER,
    }


# ---------------------------------------------------------------------------
# Black–Scholes helpers
# ---------------------------------------------------------------------------

def _d1_d2(
    S: float, K: float, T: float, r: float, sigma: float
) -> (float, float):
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        raise ValueError("Invalid inputs to d1/d2.")
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return d1, d2


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _implied_vol_put_bisection(
    market_price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    tol: float = 1e-4,
    max_iter: int = 100,
    sigma_low: float = 1e-4,
    sigma_high: float = 5.0,
) -> Optional[float]:
    def bs_put_price(sigma: float) -> float:
        d1, d2 = _d1_d2(S, K, T, r, sigma)
        from math import exp
        return K * exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)

    try:
        price_low = bs_put_price(sigma_low)
        price_high = bs_put_price(sigma_high)
    except ValueError:
        return None

    if not (price_low <= market_price <= price_high):
        return None

    for _ in range(max_iter):
        sigma_mid = 0.5 * (sigma_low + sigma_high)
        try:
            price_mid = bs_put_price(sigma_mid)
        except ValueError:
            return None

        if abs(price_mid - market_price) < tol:
            return sigma_mid

        if price_mid > market_price:
            sigma_high = sigma_mid
        else:
            sigma_low = sigma_mid

    return None


def _black_scholes_put_delta(
    S: float, K: float, T: float, r: float, sigma: float
) -> float:
    d1, _ = _d1_d2(S, K, T, r, sigma)
    return _norm_cdf(d1) - 1.0  # negative


def _compute_model_delta_iv(
    *,
    S: float,
    K: float,
    T: float,
    r: float,
    bid: Optional[float],
    ask: Optional[float],
    last: Optional[float],
) -> (Optional[float], Optional[float]):
    """
    Compute delta and IV from Black–Scholes if vendor data is not available.
    """
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        market_price = 0.5 * (bid + ask)
    elif last is not None and last > 0:
        market_price = last
    else:
        return None, None

    iv = _implied_vol_put_bisection(market_price, S, K, T, r)
    if iv is None or iv <= 0:
        return None, None

    try:
        delta = _black_scholes_put_delta(S, K, T, r, iv)
    except ValueError:
        return None, None

    return delta, iv


def _mid_price(
    bid: Optional[float], ask: Optional[float], last: Optional[float]
) -> Optional[float]:
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return 0.5 * (bid + ask)
    if last is not None and last > 0:
        return last
    return None


# ---------------------------------------------------------------------------
# Simple chain endpoint (provider-agnostic)
# ---------------------------------------------------------------------------

@app.get("/options-chain-simple/{ticker}")
def get_simplified_options_chain(
    ticker: str,
    contract_type: str,
    expiration_date: str,
):
    """
    Simple debugging endpoint: returns a simplified options chain
    for a given ticker / type / expiration from the active provider.
    """
    contract_type = contract_type.lower()
    if contract_type not in ("call", "put"):
        raise HTTPException(status_code=400, detail="contract_type must be 'call' or 'put'")

    contracts: List[OptionContract] = get_option_chain(ticker, expiration_date)
    side = [c for c in contracts if c.option_type == contract_type]

    options: List[Dict[str, Any]] = []
    for c in side:
        mid = _mid_price(c.bid, c.ask, c.last)
        options.append(
            {
                "underlying": c.underlying,
                "option_ticker": c.option_ticker,
                "contract_type": c.option_type,
                "expiration_date": c.expiry.isoformat(),
                "strike_price": c.strike,
                "bid": c.bid,
                "ask": c.ask,
                "put_mid": mid,
                "last": c.last,
                "volume": c.volume,
                "open_interest": c.open_interest,
                "delta": c.delta,
                "gamma": c.gamma,
                "theta": c.theta,
                "vega": c.vega,
                "iv": c.implied_vol,
                "greeks_source": c.greeks_source,
            }
        )

    return {
        "status": "OK",
        "count": len(options),
        "options": options,
    }


# ---------------------------------------------------------------------------
# Rolling PUT strategy endpoint (provider-agnostic)
# ---------------------------------------------------------------------------

@app.get("/rolling-put-candidates/{ticker}")
def rolling_put_candidates(
    ticker: str,
    expiration_date: str,
    delta_min: float = ROLLING_DEFAULTS["delta_min"],
    delta_max: float = ROLLING_DEFAULTS["delta_max"],
    band_window: float = ROLLING_DEFAULTS["band_window"],
    credit_min_pct: float = ROLLING_DEFAULTS["credit_min_pct"],
    credit_max_pct: float = ROLLING_DEFAULTS["credit_max_pct"],
):
    """
    Strategy endpoint for the app, using the active data provider.
    """

    # --- 1) Fetch full chain for this expiration from provider ---
    contracts: List[OptionContract] = get_option_chain(ticker, expiration_date)
    call_chain = [c for c in contracts if c.option_type == "call"]
    put_chain = [c for c in contracts if c.option_type == "put"]

    if not call_chain or not put_chain:
        return {
            "status": "NO_DATA",
            "ticker": ticker.upper(),
            "expiration_date": expiration_date,
            "atm_strike": None,
            "em": None,
            "spot_approx": None,
            "lower_band": None,
            "delta_range": [delta_min, delta_max],
            "credit_pct_range": [credit_min_pct, credit_max_pct],
            "count": 0,
            "opportunities": [],
            "neighbors": [],
            "incomplete": [],
        }

    # --- 2) Determine approximate ATM strike and spot ---

    # 2.1. Primero intentamos con deltas de CALL (caso Tradier)
    valid_calls = [c for c in call_chain if c.delta is not None]

    if valid_calls:
        def call_delta_distance(c: OptionContract) -> float:
            return abs(abs(c.delta) - 0.5)

        atm_call = min(valid_calls, key=call_delta_distance)
        atm_strike = atm_call.strike

        # Spot aproximado = strike ATM (como antes)
        spot_approx = float(atm_strike)

    else:
        # 2.2. Fallback genérico (caso Yahoo / proveedor sin deltas)
        # Usamos paridad C - P + K para estimar el spot S en cada strike
        def _mid_opt(c: OptionContract) -> Optional[float]:
            return _mid_price(c.bid, c.ask, c.last)

        # Construimos diccionarios strike -> mid
        call_mids = {c.strike: _mid_opt(c) for c in call_chain}
        put_mids = {p.strike: _mid_opt(p) for p in put_chain}

        spot_estimates = []

        for strike, c_mid in call_mids.items():
            p_mid = put_mids.get(strike)
            if c_mid is None or p_mid is None:
                continue
            # Paridad aproximada (ignoramos descuento)
            S_est = c_mid - p_mid + strike
            spot_estimates.append((strike, S_est))

        if not spot_estimates:
            raise HTTPException(
                status_code=404,
                detail="Cannot determine ATM strike: no usable CALL/PUT mid prices.",
            )

        # Spot aproximado = mediana de los S_est
        s_values = [s for _, s in spot_estimates]
        s_values.sort()
        mid_idx = len(s_values) // 2
        if len(s_values) % 2 == 1:
            spot_approx = float(s_values[mid_idx])
        else:
            spot_approx = float(0.5 * (s_values[mid_idx - 1] + s_values[mid_idx]))

        # Elegimos como ATM el strike más cercano a ese spot aproximado
        strikes = [k for k, _ in spot_estimates]
        atm_strike = min(strikes, key=lambda k: abs(k - spot_approx))

        # Y tomamos cualquier CALL con ese strike
        atm_call = next(c for c in call_chain if c.strike == atm_strike)

    # --- 3) Estimate EM from ATM straddle mid prices ---
    atm_put = next((p for p in put_chain if p.strike == atm_strike), None)

    call_mid = _mid_price(atm_call.bid, atm_call.ask, atm_call.last)
    put_mid_atm = _mid_price(
        atm_put.bid, atm_put.ask, atm_put.last
    ) if atm_put is not None else None

    if call_mid is None or put_mid_atm is None:
        return {
            "status": "NO_DATA",
            "message": "Cannot compute EM: missing prices at ATM for this expiration.",
            "ticker": ticker.upper(),
            "expiration_date": expiration_date,
            "meta": {
                "has_chain": bool(call_chain and put_chain),
                "reason": "missing_atm_prices",
            },
        }

    em = call_mid + put_mid_atm

    # --- 4) Compute lower band ---
    lower_band = spot_approx - em

    # --- 5) Compute time to expiration (T in years) ---
    try:
        exp_dt = datetime.strptime(expiration_date, "%Y-%m-%d")
        today = datetime.utcnow()
        days_to_exp = max((exp_dt - today).days, 1)
        T = days_to_exp / 365.0
    except Exception:
        T = 30.0 / 365.0

    # --- 6) Build list of PUT opportunities ---
    opportunities: List[Dict[str, Any]] = []
    neighbors: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, Any]] = []

    enriched_puts: List[Dict[str, Any]] = []

    for opt in put_chain:
        strike = opt.strike
        last = opt.last
        bid = opt.bid
        ask = opt.ask
        mid_price = _mid_price(bid, ask, last)

        delta = opt.delta
        iv = opt.implied_vol
        greeks_source = opt.greeks_source

        # If vendor delta/iv are missing, try to compute them
        if delta is None or iv is None:
            model_delta, model_iv = _compute_model_delta_iv(
                S=spot_approx,
                K=strike,
                T=T,
                r=RISK_FREE_RATE,
                bid=bid,
                ask=ask,
                last=last,
            )
            if model_delta is not None and model_iv is not None:
                delta = model_delta
                iv = model_iv
                greeks_source = "model"

        # If we still have no delta, mark as incomplete and continue
        if delta is None:
            credit_pct = None
            if mid_price is not None and spot_approx > 0:
                credit_pct = mid_price / spot_approx

            incomplete.append(
                {
                    "option_ticker": opt.option_ticker,
                    "strike_price": strike,
                    "last": last,
                    "put_mid": mid_price,
                    "volume": opt.volume,
                    "open_interest": opt.open_interest,
                    "distance_to_lower_band": strike - lower_band,
                    "credit_pct": credit_pct,
                    "iv": iv,
                    "greeks_source": greeks_source,
                    "reason_missing": "no_usable_delta",
                }
            )
            continue

        # Compute credit % from mid price
        if mid_price is not None and spot_approx > 0:
            credit_pct = mid_price / spot_approx
        else:
            credit_pct = None

        distance = strike - lower_band

        enriched_puts.append(
            {
                "option_ticker": opt.option_ticker,
                "strike_price": strike,
                "last": last,
                "put_mid": mid_price,
                "delta": delta,
                "iv": iv,
                "greeks_source": greeks_source,
                "volume": opt.volume,
                "open_interest": opt.open_interest,
                "distance_to_lower_band": distance,
                "credit_pct": credit_pct,
            }
        )
    # 6.4 Filter enriched puts by band window, delta, and credit
    filtered: List[Dict[str, Any]] = []
    for row in enriched_puts:
        s = row["strike_price"]
        d = abs(row["delta"])
        cp = row["credit_pct"]

        in_band = (s >= (lower_band - band_window)) and (s <= (lower_band + band_window))
        in_delta = (d >= delta_min) and (d <= delta_max)
        in_credit = (
            cp is not None
            and cp >= credit_min_pct
            and cp <= credit_max_pct
        )

        row["meets_band"] = in_band
        row["meets_delta"] = in_delta
        row["meets_credit"] = in_credit

        if in_band and in_delta and in_credit:
            filtered.append(row)

    # 6.5 (removed) – no fallback; if `filtered` is empty we just won't have opportunities

    # 6.6 Mark opportunities and neighbors
    opportunities: List[Dict[str, Any]] = []
    neighbors: List[Dict[str, Any]] = []

    if filtered:
        strikes = [r["strike_price"] for r in enriched_puts]
        strikes_sorted = sorted(set(strikes))

        opp_strikes = [r["strike_price"] for r in filtered]

        def idx_of(strike: float) -> int:
            return strikes_sorted.index(strike)

        neighbor_indices = set()
        for s in opp_strikes:
            i = idx_of(s)
            if i - 1 >= 0:
                neighbor_indices.add(strikes_sorted[i - 1])
            if i + 1 < len(strikes_sorted):
                neighbor_indices.add(strikes_sorted[i + 1])

        for row in filtered:
            row["type"] = "opportunity"
            opportunities.append(row)

        opp_strike_set = set(opp_strikes)
        for row in enriched_puts:
            s = row["strike_price"]
            if s in neighbor_indices and s not in opp_strike_set:
                r = dict(row)
                r["type"] = "neighbor"
                r.setdefault("meets_band", False)
                r.setdefault("meets_delta", False)
                r.setdefault("meets_credit", False)
                neighbors.append(r)

        neighbors.sort(key=lambda r: r["strike_price"])

    # Final response
    return {
        "status": "OK",
        "ticker": ticker.upper(),
        "expiration_date": expiration_date,
        "atm_strike": atm_strike,
        "em": em,
        "spot_approx": spot_approx,
        "lower_band": lower_band,
        "delta_range": [delta_min, delta_max],
        "credit_pct_range": [credit_min_pct, credit_max_pct],
        "count": len(opportunities),
        "opportunities": opportunities,
        "neighbors": neighbors,
        "incomplete": incomplete,
    }
