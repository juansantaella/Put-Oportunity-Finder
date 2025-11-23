import { useEffect, useState } from "react";
import "./App.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  "https://put-oportunity-finder.onrender.com";

const REFRESH_INTERVAL_MS = 10000; // 10 seconds

// const COMMON_TICKERS = ["AAPL", "AMZN", "MSFT", "SPY", "QQQ", "TSLA", "META", "NVDA"];

interface BaseOptionRow {
  option_ticker: string;
  strike_price: number;
  last: number | null;
  bid?: number | null;
  ask?: number | null;
  put_mid?: number | null;
  delta?: number | null;
  iv?: number | null;
  greeks_source?: string;
  volume: number | null;
  open_interest: number | null;
  distance_to_lower_band?: number | null;
  credit_pct?: number | null;
}

interface OpportunityRow extends BaseOptionRow {
  meets_band: boolean;
  meets_delta: boolean;
  meets_credit: boolean;
  type: "opportunity" | "neighbor";
}

interface IncompleteRow extends BaseOptionRow {
  reason_missing: string;
}

interface RollingResponse {
  status: string;
  ticker: string;
  expiration_date: string;
  atm_strike: number;
  em: number;
  spot_approx: number;
  lower_band: number;
  delta_range: [number, number];
  credit_pct_range: [number, number];
  count: number;
  opportunities: OpportunityRow[];
  neighbors: OpportunityRow[];
  incomplete: IncompleteRow[];
}

type Profile = "Conservative" | "Normal" | "Aggressive" | "Custom";

type Classification =
  | "best"
  | "opportunity"       // banda + delta + crédito (full match, no-best)
  | "candidate_strong"  // banda + (solo delta o solo crédito)
  | "candidate"         // solo banda
  | "neighbor";

interface ClassifiedRow extends OpportunityRow {
  classification: Classification;
  score: string;
  rowClass: string;
}

interface QueryParams {
  ticker: string;
  expiration: string;
  deltaMin: number;
  deltaMax: number;
  bandWindow: number;
  creditMin: number;
  creditMax: number;
  showNeighbors: boolean;
  numExpirations: number;
}

// ---------- Helpers ----------

function classifyRow(row: OpportunityRow): Classification {
  const { type, meets_band, meets_delta, meets_credit } = row;

  // Vecinos siempre son "neighbor": solo contexto, sin highlight
  if (type === "neighbor") {
    return "neighbor";
  }

  // Fuera de la banda (caso raro en opportunities) → vecino / neutro
  if (!meets_band) {
    return "neighbor";
  }

  // Full match: banda + delta + crédito
  if (meets_delta && meets_credit) {
    return "opportunity"; // luego uno de estos se promociona a "best"
  }

  // Banda + (solo delta o solo crédito) → candidato “fuerte”
  if (meets_delta !== meets_credit) {
    return "candidate_strong";
  }

  // Solo banda (ni delta ni crédito) → candidato “suave”
  return "candidate";
}


function formatProviderLabel(p: string | null): string {
  if (!p) return "Unknown (check backend)";

  const v = p.toLowerCase();
  if (v === "tradier_sandbox") return "Tradier (sandbox / paper)";
  if (v === "tradier_production") return "Tradier (live)";
  if (v === "massive") return "Massive (options & greeks, snapshot/delayed)";
  if (v === "yahoo") return "Yahoo Finance (delayed / informational)";

  return p; // fallback: show raw value
}

function scoreForClassification(c: Classification): string {
  switch (c) {
    case "best":
      // Row that meets band + delta + credit and has the BEST credit
      return "★";      // BEST
    case "opportunity":
      // Row that meets band + delta + credit (full match, but not the best)
      return "✓";      // OPPORTUNITY
    default:
      // Candidates (band only or band + one filter) and neighbors
      // should NOT show any symbol in the Score column
      return "";
  }
}

function rowClassForClassification(c: Classification): string {
  switch (c) {
    case "best":
      // BEST (★) y OPPORTUNITY full pueden compartir el tono más intenso
      return "row-best";
    case "opportunity":
      // Full match (banda + delta + crédito, sin ser BEST)
      return "row-best";
    case "candidate_strong":
      // Banda + (solo delta o solo crédito) → verde intermedio
      return "row-opportunity";
    case "candidate":
      // Solo banda → verde más claro
      return "row-candidate";
    case "neighbor":
      // Vecinos → neutro
      return "row-neighbor";
    default:
      return "";
  }
}

function formatNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toFixed(digits);
}

function formatPercent(p: number | null | undefined, digits = 2): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "-";
  return `${(p * 100).toFixed(digits)}%`;
}

function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString();
}

function formatTime(date: Date | null): string {
  if (!date) return "-";
  return date.toLocaleTimeString();
}

// Build list of expirations: base, base+7d, base+14d, ...
function buildExpirationList(base: string, count: number): string[] {
  const result: string[] = [];

  // Parse YYYY-MM-DD manually
  const parts = base.split("-");
  if (parts.length !== 3) {
    // Fallback: if base is invalid, just repeat it
    for (let i = 0; i < count; i++) result.push(base);
    return result;
  }

  const [yStr, mStr, dStr] = parts;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);

  if (!y || !m || !d) {
    for (let i = 0; i < count; i++) result.push(base);
    return result;
  }

  // Use a UTC date to avoid timezone shifts
  const baseDate = new Date(Date.UTC(y, m - 1, d));

  for (let i = 0; i < count; i++) {
    const dt = new Date(baseDate);
    dt.setUTCDate(baseDate.getUTCDate() + 7 * i);

    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");

    result.push(`${yyyy}-${mm}-${dd}`);
  }

  return result;
}


// ---------- Component ----------

function App() {
  // Slider / filter limits (front-end only)
  const DELTA_MAX_MIN = 0.1;        // 0.10
  const DELTA_MAX_MAX = 0.5;        // 0.50
  const DELTA_MAX_STEP = 0.05;      // 0.05

  const CREDIT_MIN_MIN = 0.003;     // 0.30 %
  const CREDIT_MIN_MAX = 0.02;      // 2.00 %
  const CREDIT_MIN_STEP = 0.0005;   // 0.05 %

  const BAND_MIN = 1;
  const BAND_MAX = 10;

  // Control panel state
  const [ticker, setTicker] = useState("AAPL");
  const [expiration, setExpiration] = useState("2025-11-28");

  // We keep a fixed lower bound for |Δ| and only expose Max Δ to the user
  const [deltaMin, setDeltaMin] = useState(DELTA_MAX_MIN);
  const [deltaMax, setDeltaMax] = useState(0.3); // Normal (default) profile

  // Stored as decimal (e.g. 0.007 = 0.70 %)
  const [creditMin, setCreditMin] = useState(0.007);
  const [creditMax, setCreditMax] = useState(CREDIT_MIN_MAX);

  const [bandWindow, setBandWindow] = useState(1);

  // 1 = base only; we allow up to 3 weekly expirations in total
  const [numExpirations, setNumExpirations] = useState(1);

  const [showNeighbors, setShowNeighbors] = useState(true);
  const [liveUpdate, setLiveUpdate] = useState(false);
  const [profile, setProfile] = useState<Profile>("Normal");

  // NEW: Provider info
  const [dataProvider, setDataProvider] = useState<string | null>(null);

  // Data / status
  const [records, setRecords] = useState<RollingResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Auto-refresh
  const [lastQuery, setLastQuery] = useState<QueryParams | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Which expiration has its "incomplete" block expanded
  const [expandedIncomplete, setExpandedIncomplete] = useState<string | null>(
    null
  );

  // ---- Helpers to mark profile as Custom when user changes filters ----
  const markCustom = () => {
    if (profile !== "Custom") setProfile("Custom");
  };


  // ---- Fetch all expirations ----
  async function fetchAll(params?: QueryParams) {
    const effective: QueryParams =
      params ??
      lastQuery ?? {
        ticker,
        expiration,
        deltaMin,
        deltaMax,
        bandWindow,
        creditMin,
        creditMax,
        showNeighbors,
        numExpirations,
      };

    setLastQuery(effective);
    setLoading(true);
    setError(null);

    try {
      const expirations = buildExpirationList(
        effective.expiration,
        effective.numExpirations
      );

      const promises = expirations.map(async (expDate) => {
        const url = new URL(
          `${API_BASE}/rolling-put-candidates/${effective.ticker}`
        );
        url.searchParams.set("expiration_date", expDate);
        url.searchParams.set("delta_min", effective.deltaMin.toString());
        url.searchParams.set("delta_max", effective.deltaMax.toString());
        url.searchParams.set("band_window", effective.bandWindow.toString());
        url.searchParams.set("credit_min_pct", effective.creditMin.toString());
        url.searchParams.set("credit_max_pct", effective.creditMax.toString());

        const resp = await fetch(url.toString());
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const json: RollingResponse = await resp.json();
        return json;
      });

      const results = await Promise.all(promises);
      setRecords(results);
      setLastUpdated(new Date());
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Failed to fetch");
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }

  function handleLoadClick() {
    const params: QueryParams = {
      ticker,
      expiration,
      deltaMin,
      deltaMax,
      bandWindow,
      creditMin,
      creditMax,
      showNeighbors,
      numExpirations,
    };
    fetchAll(params);
  }

  // Fetch backend info (including active data provider) once on mount
  useEffect(() => {
    async function fetchBackendInfo() {
      try {
        const resp = await fetch(`${API_BASE}/`);
        if (!resp.ok) return;
        const json = await resp.json();
        if (json && typeof json.data_provider === "string") {
          setDataProvider(json.data_provider);
        }
      } catch {
        // si falla, simplemente dejamos dataProvider como null
      }
    }
    fetchBackendInfo();
  }, []);

  // Auto-refresh timer
  useEffect(() => {
    if (!liveUpdate || !lastQuery) {
      setCountdown(null);
      return;
    }

    setCountdown(REFRESH_INTERVAL_MS / 1000);

    const id = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          fetchAll();
          return REFRESH_INTERVAL_MS / 1000;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUpdate, lastQuery]);

  // Profile buttons
  function applyProfile(p: Exclude<Profile, "Custom">) {
    setProfile(p);

    // All profiles share the same lower bound for |Δ| and the same max credit
    setDeltaMin(DELTA_MAX_MIN);
    setCreditMax(CREDIT_MIN_MAX);
    setBandWindow(1);
    // setNumExpirations(1);

    if (p === "Conservative") {
      // Max Delta 0.25, Min Credit 0.60 %
      setDeltaMax(0.25);
      setCreditMin(0.006);
    } else if (p === "Aggressive") {
      // Max Delta 0.35, Min Credit 0.70 %
      setDeltaMax(0.35);
      setCreditMin(0.007);
    } else {
      // Normal (default): Max Delta 0.30, Min Credit 0.70 %
      setDeltaMax(0.3);
      setCreditMin(0.007);
    }
  }

  function handleFactoryReset() {
    applyProfile("Normal");
  }

  // Handlers for sliders / numeric inputs
  const handleDeltaMaxChange = (val: number) => {
    if (Number.isNaN(val)) return;

    let clamped = Math.max(DELTA_MAX_MIN, Math.min(DELTA_MAX_MAX, val));

    // Ensure max delta is never below the fixed lower bound
    if (clamped < deltaMin) {
      clamped = deltaMin;
    }

    setDeltaMax(clamped);
    markCustom();
  };

  const handleCreditMinChange = (val: number) => {
    if (Number.isNaN(val)) return;

    const clamped = Math.max(CREDIT_MIN_MIN, Math.min(CREDIT_MIN_MAX, val));
    setCreditMin(clamped);
    markCustom();
  };

  const handleBandWindowChange = (val: number) => {
    if (Number.isNaN(val)) return;

    const clamped = Math.max(
      BAND_MIN,
      Math.min(BAND_MAX, Math.round(val))
    );
    setBandWindow(clamped);
    markCustom();
  };

  const handleNumExpChange = (val: number) => {
    if (Number.isNaN(val)) return;
    const clamped = Math.min(3, Math.max(1, Math.round(val)));
    setNumExpirations(clamped);
  };


  // ---------- Render ----------

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>Put Oportunity Finder</h1>
          <p className="subtitle">
            Scan short put opportunities around the lower band using delta and
            credit filters.
          </p>
        </div>
        <div className="profile-panel">
          <span className="profile-label">Profile:</span>
          <div className="profile-buttons">
            <button
              className={
                profile === "Conservative"
                  ? "profile-btn active"
                  : "profile-btn"
              }
              onClick={() => applyProfile("Conservative")}
            >
              Conservative
            </button>
            <button
              className={
                profile === "Normal" ? "profile-btn active" : "profile-btn"
              }
              onClick={() => applyProfile("Normal")}
            >
              Normal
            </button>
            <button
              className={
                profile === "Aggressive"
                  ? "profile-btn active"
                  : "profile-btn"
              }
              onClick={() => applyProfile("Aggressive")}
            >
              Aggressive
            </button>
            <span
              className={
                profile === "Custom" ? "profile-custom active" : "profile-custom"
              }
            >
              Custom
            </span>
          </div>
        </div>
      </header>

      <main>
        <section className="card control-panel">
          <h2>Control Panel</h2>

          {/* Ticker / base expiration */}
          <div className="grid-2">
            <div className="field">
              <label>Ticker</label>
              <input
                value={ticker}
                onChange={(e) =>
                  setTicker(e.target.value.toUpperCase())
                }
                placeholder="AAPL"
              />
            </div>

            <div className="field">
              <label>Base expiration (YYYY-MM-DD)</label>
              <input
                value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
                placeholder="2025-11-28"
              />
            </div>
          </div>

          {/* Max Delta / Min Credit */}
          <div className="grid-2">
            <div className="field">
              <label>Max Delta (abs)</label>
              <div className="slider-row">
                <input
                  type="range"
                  min={DELTA_MAX_MIN}
                  max={DELTA_MAX_MAX}
                  step={DELTA_MAX_STEP}
                  value={deltaMax}
                  onChange={(e) =>
                    handleDeltaMaxChange(parseFloat(e.target.value))
                  }
                />
              </div>
              <input
                type="number"
                min={DELTA_MAX_MIN}
                max={DELTA_MAX_MAX}
                step={DELTA_MAX_STEP}
                value={deltaMax.toFixed(2)}
                onChange={(e) =>
                  handleDeltaMaxChange(parseFloat(e.target.value))
                }
              />
            </div>

            <div className="field">
              <label>Min Credit (%)</label>
              <div className="slider-row">
                <input
                  type="range"
                  min={CREDIT_MIN_MIN}
                  max={CREDIT_MIN_MAX}
                  step={CREDIT_MIN_STEP}
                  value={creditMin}
                  onChange={(e) =>
                    handleCreditMinChange(parseFloat(e.target.value))
                  }
                />
              </div>
              <input
                type="number"
                min={CREDIT_MIN_MIN * 100}
                max={CREDIT_MIN_MAX * 100}
                step={CREDIT_MIN_STEP * 100}
                value={(creditMin * 100).toFixed(2)}
                onChange={(e) => {
                  const pct = parseFloat(e.target.value);
                  if (!Number.isNaN(pct)) {
                    handleCreditMinChange(pct / 100);
                  }
                }}
              />
            </div>
          </div>

          {/* Band distance / future expirations */}
          <div className="grid-2">
            <div className="field">
              <label>Distance from lower band (+/- point)</label>
              <div className="slider-row">
                <input
                  type="range"
                  min={BAND_MIN}
                  max={BAND_MAX}
                  step={1}
                  value={bandWindow}
                  onChange={(e) =>
                    handleBandWindowChange(parseFloat(e.target.value))
                  }
                />
              </div>
              <input
                type="number"
                min={BAND_MIN}
                max={BAND_MAX}
                step={1}
                value={bandWindow}
                onChange={(e) =>
                  handleBandWindowChange(parseFloat(e.target.value))
                }
              />
            </div>

            <div className="field">
              <label>
                Number of future expirations (weekly steps) 1 = Base only,
                up to 3 total
              </label>
              <div className="slider-row">
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  value={numExpirations}
                  onChange={(e) =>
                    handleNumExpChange(parseFloat(e.target.value))
                  }
                />
              </div>
              <input
                type="number"
                min={1}
                max={3}
                step={1}
                className="exp-count-field"
                value={numExpirations}
                onChange={(e) =>
                  handleNumExpChange(parseFloat(e.target.value))
                }
              />
            </div>
          </div>

          {/* Toggles */}
          <div className="toggles">
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={showNeighbors}
                onChange={(e) => setShowNeighbors(e.target.checked)}
              />
              <span>Show neighbors</span>
            </div>

            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={liveUpdate}
                onChange={(e) => setLiveUpdate(e.target.checked)}
              />
              <span>Live update (auto-refresh)</span>
            </div>
          </div>

          {/* Actions + status */}
          <div className="actions-row">
            <button
              className="primary-btn"
              onClick={handleLoadClick}
              disabled={loading}
            >
              {loading ? "Loading…" : "Load opportunities"}
            </button>

            <button className="secondary-btn" onClick={handleFactoryReset}>
              Factory defaults
            </button>

            <div className="status-text">
              <div>
                Last updated:&nbsp;
                <span>{formatTime(lastUpdated)}</span>
              </div>
              {liveUpdate && (
                <div>
                  Auto-refresh every 10 s.&nbsp;
                  {countdown !== null && (
                    <span className="countdown">
                      Next refresh in {countdown}s
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <p className="hint">
            Auto-refresh uses the last search parameters. Turn it off if you
            want to “freeze” the snapshot.
          </p>
        </section>

        <section className="card">
          <h2>Opportunities</h2>

          <p className="hint">
            Data source: {formatProviderLabel(dataProvider)}.
          </p>

          {error && <div className="error-banner">Error: {error}</div>}

          {!error && records.length > 0 && (
            <>
              {records.map((data) => {
                const baseRows: OpportunityRow[] = [
                  ...data.opportunities,
                  ...(showNeighbors ? data.neighbors : []),
                ];

                const sorted = baseRows.sort(
                  (a, b) => a.strike_price - b.strike_price
                );

                // 1) Clasificación inicial
                const prelim: ClassifiedRow[] = sorted.map((row) => {
                  const classification = classifyRow(row);
                  return {
                    ...row,
                    classification,
                    score: "",
                    rowClass: "",
                  };
                });

                // 2) Identificar BEST (★): full match con mejor crédito
                const fullMatches = prelim.filter(
                  (r) => r.classification === "opportunity" && r.credit_pct != null
                );
                const maxCredit =
                  fullMatches.length > 0
                    ? Math.max(
                        ...fullMatches.map((r) => r.credit_pct ?? 0)
                      )
                    : null;

                const rowsWithScore: ClassifiedRow[] = prelim.map((row) => {
                  let classification = row.classification;

                  if (
                    classification === "opportunity" &&
                    maxCredit !== null &&
                    row.credit_pct != null &&
                    row.credit_pct === maxCredit
                  ) {
                    classification = "best";
                  }

                  const score = scoreForClassification(classification);
                  const rowClass = rowClassForClassification(classification);

                  return {
                    ...row,
                    classification,
                    score,
                    rowClass,
                  };
                });

                const hasRows = rowsWithScore.length > 0;

                // 3) Incomplete rows (sin delta utilizable)
                const incompleteSorted = [...data.incomplete].sort(
                  (a, b) => a.strike_price - b.strike_price
                );
                const hasIncomplete = incompleteSorted.length > 0;

                const isExpanded =
                  expandedIncomplete === data.expiration_date;

                const toggleIncomplete = () => {
                  setExpandedIncomplete(
                    isExpanded ? null : data.expiration_date
                  );
                };

                return (
                  <div
                    key={`${data.ticker}-${data.expiration_date}`}
                    className="expiration-block"
                  >
                    {/* Resumen de esa expiración */}
                    <div className="summary-line">
                      <span>
                        Ticker: <b>{data.ticker}</b>
                      </span>
                      <span>
                        Expiration: <b>{data.expiration_date}</b>
                      </span>
                      <span>
                        Spot (approx):{" "}
                        <b>{formatNumber(data.spot_approx)}</b>
                      </span>
                      <span>
                        ATM strike:{" "}
                        <b>{formatNumber(data.atm_strike)}</b>
                      </span>
                      <span>
                        EM: <b>{formatNumber(data.em)}</b>
                      </span>
                      <span>
                        Lower band:{" "}
                        <b>{formatNumber(data.lower_band)}</b>
                      </span>
                    </div>

                    {/* Tabla principal */}
                    <div className="table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Type</th>
                            <th>Strike</th>
                            <th>Delta</th>
                            <th>Credit %</th>
                            <th>Mid (Put)</th>
                            <th>Volume</th>
                            <th>Open Int.</th>
                            <th>Greeks src</th>
                            <th>Dist. to band</th>
                            <th>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hasRows ? (
                            rowsWithScore.map((row) => (
                              <tr
                                key={row.option_ticker}
                                className={row.rowClass}
                              >
                                <td>{row.type}</td>
                                <td>{formatNumber(row.strike_price)}</td>
                                <td>{formatNumber(row.delta)}</td>
                                <td>{formatPercent(row.credit_pct)}</td>
                                <td>{formatNumber(row.put_mid)}</td>
                                <td>{formatInt(row.volume)}</td>
                                <td>{formatInt(row.open_interest)}</td>
                                <td>{row.greeks_source ?? "-"}</td>
                                <td>
                                  {formatNumber(
                                    row.distance_to_lower_band
                                  )}
                                </td>
                                <td style={{ textAlign: "center" }}>
                                  {row.score}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td
                                className="empty-cell"
                                colSpan={10}
                              >
                                No rows match for this expiration. Try
                                adjusting your filters.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Sección de incompletos */}
                    {hasIncomplete && (
                      <div className="incomplete-section">
                        <button
                          className="incomplete-toggle"
                          onClick={toggleIncomplete}
                        >
                          {isExpanded
                            ? "Hide rows with missing greeks"
                            : `Show ${incompleteSorted.length} rows with missing greeks`}
                        </button>

                        {isExpanded && (
                          <div className="table-wrapper secondary">
                            <table className="data-table small">
                              <thead>
                                <tr>
                                  <th>Strike</th>
                                  <th>Mid (Put)</th>
                                  <th>Volume</th>
                                  <th>Open Int.</th>
                                  <th>Credit %</th>
                                  <th>IV</th>
                                  <th>Reason</th>
                                </tr>
                              </thead>
                              <tbody>
                                {incompleteSorted.map((row) => (
                                  <tr
                                    key={row.option_ticker}
                                  >
                                    <td>
                                      {formatNumber(
                                        row.strike_price
                                      )}
                                    </td>
                                    <td>
                                      {formatNumber(row.put_mid)}
                                    </td>
                                    <td>
                                      {formatInt(row.volume)}
                                    </td>
                                    <td>
                                      {formatInt(
                                        row.open_interest
                                      )}
                                    </td>
                                    <td>
                                      {formatPercent(
                                        row.credit_pct
                                      )}
                                    </td>
                                    <td>
                                      {formatNumber(row.iv)}
                                    </td>
                                    <td>
                                      {row.reason_missing ??
                                        "missing data"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    <hr className="exp-separator" />
                  </div>
                );
              })}

              {/* Resumen de perfil DESPUÉS de todas las tablas */}
              <p className="profile-summary">
                Profile:&nbsp;<b>{profile}</b> · Max Δ:&nbsp;
                <b>{deltaMax.toFixed(2)}</b> · Min credit:&nbsp;
                <b>{(creditMin * 100).toFixed(2)}%</b> · Band distance:&nbsp;
                <b>{bandWindow}</b> · Future expirations:&nbsp;
                <b>{numExpirations}</b>
              </p>
            </>
          )}

          {/* Caso: ya hiciste una búsqueda pero ninguna expiración tuvo filas */}
          {!error && lastQuery && !loading && records.length === 0 && (
            <p className="hint">
              No expirations produced opportunities for the current filters.
              Consider lowering the minimum credit or raising the maximum delta.
            </p>
          )}

          {/* Caso inicial: todavía no se ha hecho búsqueda */}
          {!error && !lastQuery && !loading && records.length === 0 && (
            <p className="hint">
              Set your filters and click <b>Load opportunities</b> to see
              results.
            </p>
          )}

        </section>
      </main>
    </div>
  );
}

export default App;
