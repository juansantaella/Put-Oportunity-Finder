import os
import math
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

# ---- Load environment variables (works locally and in deployment) ----
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / "Polygon_API_Key.env")
load_dotenv(BASE_DIR / "strategy_defaults.env")

API_KEY = os.getenv("POLYGON_API_KEY")

if not API_KEY:
    raise RuntimeError(
        "POLYGON_API_KEY is not set. Check Polygon_API_Key.env "
        "or the host environment variables."
    )

BASE_URL = "https://api.massive.com"
RISK_FREE_RATE = 0.04  # 4% annual risk-free rate (rough approximation)

app = FastAPI(
    title="Polygon / Massive backend",
    description="Backend for rolling short PUT strategy helper.",
    version="1.0.0",
)

# Allow local dev frontends (Vite, etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Factory defaults for rolling PUT strategy
ROLLING_DEFAULTS = {
    "delta_min": float(os.getenv("ROLLING_DELTA_MIN", "0.20")),
    "delta_max": float(os.getenv("ROLLING_DELTA_MAX", "0.25")),
    "band_window": float(os.getenv("ROLLING_BAND_WINDOW", "0.00")),
    "credit_min_pct": float(os.getenv("ROLLING_CREDIT_MIN_PCT", "0.006")),
    "credit_max_pct": float(os.getenv("ROLLING_CREDIT_MAX_PCT", "0.008")),
}


BASE_URL = "https://api.massive.com"
RISK_FREE_RATE = 0.04  # 4% annual risk-free rate (rough approximation)

app = FastAPI(
    title="Polygon / Massive backend",
    description="Backend for rolling short PUT strategy helper.",
    version="1.0.0",
)

# Allow local dev frontends (Vite, etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _massive_get(path: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Small helper to call Massive's API with the API key and handle errors.
    """
    if not API_KEY:
        raise RuntimeError("POLYGON_API_KEY is not set; cannot call Massive API.")

    url = f"{BASE_URL}{path}"

    # Copy params and add apiKey the way Massive expects it.
    full_params: Dict[str, Any] = dict(params or {})
    full_params["apiKey"] = API_KEY

    headers = {
        "accept": "application/json",
    }

    response = requests.get(url, headers=headers, params=full_params, timeout=10)
    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"Massive API error {response.status_code}: {response.text}",
        )

    return response.json()


def _d1_d2(
    S: float, K: float, T: float, r: float, sigma: float
) -> (float, float):
    """
    Black-Scholes d1 and d2.
    """
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        raise ValueError("Invalid inputs to d1/d2.")
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return d1, d2


def _norm_cdf(x: float) -> float:
    """
    Standard normal CDF using error function.
    """
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
    """
    Very simple bisection solver for implied volatility of a European put
    under Black–Scholes.

    If it fails to converge, returns None.
    """

    def bs_put_price(sigma: float) -> float:
        d1, d2 = _d1_d2(S, K, T, r, sigma)
        from math import exp

        # Put price formula
        return K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)

    try:
        price_low = bs_put_price(sigma_low)
        price_high = bs_put_price(sigma_high)
    except ValueError:
        return None

    # If market price outside bracket, we give up
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
    """
    Black–Scholes delta for a European put.

    By convention for puts: delta is negative.
    """
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

    - We first derive a "market_price" from bid/ask/last.
    - Then solve for IV via bisection.
    - Then compute delta from that IV.

    If we can't get a usable market price or the solver fails, returns (None, None).
    """
    # 1) Decide what "market price" to use
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        market_price = 0.5 * (bid + ask)
    elif last is not None and last > 0:
        market_price = last
    else:
        return None, None

    # 2) Solve IV
    iv = _implied_vol_put_bisection(market_price, S, K, T, r)
    if iv is None or iv <= 0:
        return None, None

    # 3) Delta
    try:
        delta = _black_scholes_put_delta(S, K, T, r, iv)
    except ValueError:
        return None, None

    return delta, iv


# ---------------------------------------------------------------------------
# Simple chain endpoint (for debugging and UI support)
# ---------------------------------------------------------------------------


def _fetch_simple_chain(
    ticker: str, contract_type: str, expiration_date: str, limit: int = 200
) -> List[Dict[str, Any]]:
    """
    Internal helper to fetch a simplified options chain (one side only)
    from Massive's Option Chain Snapshot endpoint and return a clean list.
    """

    # Massive v3 Option Chain Snapshot:
    #   GET /v3/snapshot/options/{underlyingAsset}
    #
    # We pass filters as query parameters.
    params = {
        "contract_type": contract_type,       # "put" or "call"
        "expiration_date": expiration_date,   # "YYYY-MM-DD"
        "limit": limit,
        "sort": "strike_price",
        "order": "asc",
    }

    path = f"/v3/snapshot/options/{ticker.upper()}"
    data = _massive_get(path, params)

    results: List[Dict[str, Any]] = []

    for opt in data.get("results", []):
        # --- Basic identifiers ---
        details = (opt.get("details") or {})
        underlying_asset = (opt.get("underlying_asset") or {})

        underlying = (
            underlying_asset.get("ticker")
            or details.get("underlying_ticker")
            or ticker.upper()
        )
        option_ticker = details.get("ticker") or details.get("symbol")
        expiration = details.get("expiration_date")
        strike = details.get("strike_price")

        # --- Volume / open interest ---
        day = (opt.get("day") or {})
        volume = day.get("volume") or day.get("v")
        oi = opt.get("open_interest")

        # --- Greeks & IV ---
        greeks = (opt.get("greeks") or {})
        delta = greeks.get("delta")
        gamma = greeks.get("gamma")
        theta = greeks.get("theta")
        vega = greeks.get("vega")

        # Some plans return IV as top-level implied_volatility,
        # older payloads may also include it in greeks["iv"].
        iv = opt.get("implied_volatility") or greeks.get("iv")

        # --- Quotes / last trade for mid price ---
        last_quote = (opt.get("last_quote") or {})
        # Option Chain Snapshot usually exposes bid/ask;
        # fall back to bid_price/ask_price if needed.
        bid = (
            last_quote.get("bid")
            or last_quote.get("bid_price")
        )
        ask = (
            last_quote.get("ask")
            or last_quote.get("ask_price")
        )

        last_trade = (opt.get("last_trade") or {})
        # For options trades Massive uses "p" for price; also check "price".
        last = last_trade.get("price") or last_trade.get("p")

        put_mid = None
        if bid is not None and ask is not None:
            put_mid = (bid + ask) / 2.0
        elif last is not None:
            put_mid = last

        greeks_source = "vendor" if (delta is not None and iv is not None) else "none"

        results.append(
            {
                "underlying": underlying,
                "option_ticker": option_ticker,
                "contract_type": contract_type,
                "expiration_date": expiration,
                "strike_price": strike,
                "bid": bid,
                "ask": ask,
                "put_mid": put_mid,
                "last": last,
                "volume": volume,
                "open_interest": oi,
                "delta": delta,
                "gamma": gamma,
                "theta": theta,
                "vega": vega,
                "iv": iv,
                "greeks_source": greeks_source,
            }
        )

    return results


@app.get("/options-chain-simple/{ticker}")
def get_simplified_options_chain(
    ticker: str,
    contract_type: str,
    expiration_date: str,
    limit: int = 200,
):
    """
    Simple debugging endpoint: returns a simplified Massive options chain
    for a given ticker / type / expiration.
    """
    chain = _fetch_simple_chain(ticker, contract_type, expiration_date, limit=limit)
    return {
        "status": "OK",
        "count": len(chain),
        "options": chain,
    }


# ---------------------------------------------------------------------------
# Rolling PUT strategy endpoint
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
    Strategy endpoint for the app.

    For the given ticker + expiration:

      * finds an approximate ATM strike using CALL deltas,
      * computes EM from the ATM straddle (call mid + put mid),
      * approximates spot as that ATM strike,
      * computes lower band = spot_approx - EM,
      * returns PUTs with |delta| between delta_min and delta_max,
        plus some extra fields for the UI (neighbors, score, etc.).
    """

    # --- 1) Fetch simplified PUT chain for this expiration ---
    put_params = {
        "contract_type": "put",
        "expiration_date": expiration_date,
        "limit": 200,
    }
    call_params = {
        "contract_type": "call",
        "expiration_date": expiration_date,
        "limit": 200,
    }

    put_chain = _fetch_simple_chain(ticker, **put_params)
    call_chain = _fetch_simple_chain(ticker, **call_params)

    # If there is no usable chain for this expiration, return an
    # empty payload instead of raising 404 so the UI can show a
    # friendly “no data for this expiration” message.
    if not put_chain or not call_chain:
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

    # --- 2) Determine approximate ATM strike from CALL deltas ---
    # Keep only calls with non-null delta
    valid_calls = [c for c in call_chain if c["delta"] is not None]

    if not valid_calls:
        raise HTTPException(
            status_code=404,
            detail="No valid CALL deltas found to determine ATM strike.",
        )

    # For calls: ATM delta ~ +0.5 (depending on convention).
    # We choose the strike whose delta is closest to 0.5
    def call_delta_distance(opt: Dict[str, Any]) -> float:
        return abs(abs(opt["delta"]) - 0.5)

    atm_call = min(valid_calls, key=call_delta_distance)
    atm_strike = atm_call["strike_price"]

    # --- 3) Estimate EM from ATM straddle mid prices ---
    # Find the corresponding PUT (same strike) if possible
    atm_put = next(
        (p for p in put_chain if p["strike_price"] == atm_strike), None
    )

    call_mid = atm_call.get("put_mid")  # for calls this is still mid price
    if call_mid is None:
        # fallback to last
        call_mid = atm_call.get("last")

    put_mid = None
    if atm_put is not None:
        put_mid = atm_put.get("put_mid")
        if put_mid is None:
            put_mid = atm_put.get("last")

    if call_mid is None or put_mid is None:
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

    em = call_mid + put_mid

    # --- 4) Approximate spot as atm_strike (reasonable for near ATM) ---
    spot_approx = float(atm_strike)

    # --- 5) Compute lower band ---
    lower_band = spot_approx - em

    # --- 6) Compute time to expiration (T in years) for BS model ---
    try:
        exp_dt = datetime.strptime(expiration_date, "%Y-%m-%d")
        today = datetime.utcnow()
        days_to_exp = max((exp_dt - today).days, 1)
        T = days_to_exp / 365.0
    except Exception:
        # If anything goes wrong, fallback to 30 days
        T = 30.0 / 365.0

    # --- 7) Build list of PUT opportunities ---
    opportunities: List[Dict[str, Any]] = []
    neighbors: List[Dict[str, Any]] = []
    incomplete: List[Dict[str, Any]] = []

    # First build a list of enriched puts with computed fields
    enriched_puts: List[Dict[str, Any]] = []

    for opt in put_chain:
        strike = opt["strike_price"]
        last = opt["last"]
        put_mid = opt["put_mid"]
        delta = opt["delta"]
        iv = opt["iv"]
        greeks_source = opt["greeks_source"]

        # 7.1 Compute mid price if not already present
        mid_price = put_mid
        if mid_price is None and last is not None:
            mid_price = last

        # 7.2 If vendor delta/iv are missing, try to compute them
        if delta is None or iv is None:
            model_delta, model_iv = _compute_model_delta_iv(
                S=spot_approx,
                K=strike,
                T=T,
                r=RISK_FREE_RATE,
                bid=opt.get("bid"),
                ask=opt.get("ask"),
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
                    "option_ticker": opt["option_ticker"],
                    "strike_price": strike,
                    "last": last,
                    "put_mid": mid_price,
                    "volume": opt["volume"],
                    "open_interest": opt["open_interest"],
                    "distance_to_lower_band": strike - lower_band,
                    "credit_pct": credit_pct,
                    "iv": iv,
                    "greeks_source": greeks_source,
                    "reason_missing": "no_usable_delta",
                }
            )
            continue

        # 7.3 Compute credit % from mid price
        if mid_price is not None and spot_approx > 0:
            credit_pct = mid_price / spot_approx
        else:
            credit_pct = None

        distance = strike - lower_band

        enriched_puts.append(
            {
                "option_ticker": opt["option_ticker"],
                "strike_price": strike,
                "last": last,
                "put_mid": mid_price,
                "delta": delta,
                "iv": iv,
                "greeks_source": greeks_source,
                "volume": opt["volume"],
                "open_interest": opt["open_interest"],
                "distance_to_lower_band": distance,
                "credit_pct": credit_pct,
            }
        )

    # 7.4 Filter enriched puts by band window, delta, and credit
    #     We treat "opportunities" as those satisfying all filters;
    #     neighbors will be added around them.
    filtered: List[Dict[str, Any]] = []
    for row in enriched_puts:
        s = row["strike_price"]
        d = abs(row["delta"])
        cp = row["credit_pct"]

        in_band = (s >= (lower_band - band_window)) and (
            s <= (lower_band + band_window)
        )
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

    # 7.5 If nothing passes all filters, we may still want rows that pass
    #     at least the band filter so that UI can show some context.
    if not filtered:
        for row in enriched_puts:
            s = row["strike_price"]
            d = abs(row["delta"])
            cp = row["credit_pct"]

            in_band = (s >= (lower_band - band_window)) and (
                s <= (lower_band + band_window)
            )
            in_delta = (d >= delta_min) and (d <= delta_max)
            in_credit = (
                cp is not None
                and cp >= credit_min_pct
                and cp <= credit_max_pct
            )

            row["meets_band"] = in_band
            row["meets_delta"] = in_delta
            row["meets_credit"] = in_credit

            if in_band and (in_delta or in_credit):
                filtered.append(row)

    # 7.6 Mark opportunities and neighbors
    # Sort by strike
    filtered.sort(key=lambda r: r["strike_price"])

    if filtered:
        strikes = [r["strike_price"] for r in enriched_puts]
        strikes_sorted = sorted(set(strikes))

        opp_strikes = [r["strike_price"] for r in filtered]

        # Helper to find index in strikes_sorted
        def idx_of(strike: float) -> int:
            return strikes_sorted.index(strike)

        neighbor_indices = set()
        for s in opp_strikes:
            i = idx_of(s)
            if i - 1 >= 0:
                neighbor_indices.add(strikes_sorted[i - 1])
            if i + 1 < len(strikes_sorted):
                neighbor_indices.add(strikes_sorted[i + 1])

        # Build final opportunities list
        for row in filtered:
            row["type"] = "opportunity"
            opportunities.append(row)

        # Build neighbors list (excluding already chosen opportunities)
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

        # Sort neighbors by strike as well
        neighbors.sort(key=lambda r: r["strike_price"])

    # Build final response
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
