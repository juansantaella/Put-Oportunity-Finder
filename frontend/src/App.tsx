import { useEffect, useState } from "react";
import "./App.css";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

const REFRESH_INTERVAL_MS = 10000; // 10 seconds

const COMMON_TICKERS = ["AAPL", "AMZN", "MSFT", "SPY", "QQQ", "TSLA", "META", "NVDA"];

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

type Classification = "best" | "strong" | "weak" | "neighbor";

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
  const { meets_band, meets_delta, meets_credit } = row;

  if (meets_band && meets_delta && meets_credit) return "best";
  if (meets_band && meets_delta) return "strong";
  if (meets_band) return "weak";
  return "neighbor";
}

function scoreForClassification(c: Classification): string {
  if (c === "best") return "★";
  if (c === "strong") return "✓";
  return "-";
}

function rowClassForClassification(c: Classification): string {
  switch (c) {
    case "best":
      return "row-best";
    case "strong":
      return "row-strong";
    case "weak":
      return "row-weak";
    default:
      return "row-neighbor";
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
  const baseDate = new Date(base);
  if (Number.isNaN(baseDate.getTime())) {
    // Fallback: if base is invalid, just repeat it
    for (let i = 0; i < count; i++) result.push(base);
    return result;
  }
  for (let i = 0; i < count; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + 7 * i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    result.push(`${yyyy}-${mm}-${dd}`);
  }
  return result;
}

// ---------- Component ----------

function App() {
  // Control panel state
  const [ticker, setTicker] = useState("AAPL");
  const [expiration, setExpiration] = useState("2025-11-28");

  const [deltaMin, setDeltaMin] = useState(0.2);
  const [deltaMax, setDeltaMax] = useState(0.25);

  const [creditMin, setCreditMin] = useState(0.006);
  const [creditMax, setCreditMax] = useState(0.008);

  const [bandWindow, setBandWindow] = useState(0);

  const [numExpirations, setNumExpirations] = useState(1); // 1 = only base

  const [showNeighbors, setShowNeighbors] = useState(true);
  const [liveUpdate, setLiveUpdate] = useState(false);
  const [profile, setProfile] = useState<Profile>("Normal");

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
    if (p === "Conservative") {
      setDeltaMin(0.18);
      setDeltaMax(0.23);
      setCreditMin(0.005);
      setCreditMax(0.007);
      setBandWindow(0);
    } else if (p === "Aggressive") {
      setDeltaMin(0.22);
      setDeltaMax(0.3);
      setCreditMin(0.006);
      setCreditMax(0.01);
      setBandWindow(2);
    } else {
      // Normal
      setDeltaMin(0.2);
      setDeltaMax(0.25);
      setCreditMin(0.006);
      setCreditMax(0.008);
      setBandWindow(0);
    }
  }

  function handleFactoryReset() {
    applyProfile("Normal");
  }

  // Handlers for sliders / numeric inputs
  const handleDeltaMinChange = (val: number) => {
    if (Number.isNaN(val)) return;
    setDeltaMin(val);
    markCustom();
  };

  const handleDeltaMaxChange = (val: number) => {
    if (Number.isNaN(val)) return;
    setDeltaMax(val);
    markCustom();
  };

  const handleCreditMinChange = (val: number) => {
    if (Number.isNaN(val)) return;
    setCreditMin(val);
    markCustom();
  };

  const handleCreditMaxChange = (val: number) => {
    if (Number.isNaN(val)) return;
    setCreditMax(val);
    markCustom();
  };

  const handleBandWindowChange = (val: number) => {
    if (Number.isNaN(val)) return;
    setBandWindow(val);
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
          <h1>Rolling Put Opportunities</h1>
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
          <h2>Control panel</h2>

          <div className="grid-2">
            <div className="field">
              <label>Ticker</label>
              <input
                list="ticker-list"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
              <datalist id="ticker-list">
                {COMMON_TICKERS.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label>Base expiration (YYYY-MM-DD)</label>
              <input
                value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label>
                Delta range (abs) — from {deltaMin.toFixed(2)} to{" "}
                {deltaMax.toFixed(2)}
              </label>

              <div className="slider-row">
                <input
                  type="range"
                  min={0.05}
                  max={0.5}
                  step={0.01}
                  value={deltaMin}
                  onChange={(e) =>
                    handleDeltaMinChange(parseFloat(e.target.value))
                  }
                />
                <input
                  type="range"
                  min={0.05}
                  max={0.5}
                  step={0.01}
                  value={deltaMax}
                  onChange={(e) =>
                    handleDeltaMaxChange(parseFloat(e.target.value))
                  }
                />
              </div>

              <div className="range-row">
                <input
                  type="number"
                  step="0.01"
                  value={deltaMin}
                  onChange={(e) =>
                    handleDeltaMinChange(parseFloat(e.target.value))
                  }
                />
                <span className="to-label">to</span>
                <input
                  type="number"
                  step="0.01"
                  value={deltaMax}
                  onChange={(e) =>
                    handleDeltaMaxChange(parseFloat(e.target.value))
                  }
                />
              </div>
            </div>

            <div className="field">
              <label>Band window (points around base strike)</label>

              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.5}
                  value={bandWindow}
                  onChange={(e) =>
                    handleBandWindowChange(parseFloat(e.target.value))
                  }
                />
              </div>

              <input
                type="number"
                step="0.5"
                value={bandWindow}
                onChange={(e) =>
                  handleBandWindowChange(parseFloat(e.target.value))
                }
              />
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label>
                Credit % range — from {(creditMin * 100).toFixed(2)}% to{" "}
                {(creditMax * 100).toFixed(2)}%
              </label>

              <div className="slider-row">
                <input
                  type="range"
                  min={0.002}
                  max={0.02}
                  step={0.001}
                  value={creditMin}
                  onChange={(e) =>
                    handleCreditMinChange(parseFloat(e.target.value))
                  }
                />
                <input
                  type="range"
                  min={0.002}
                  max={0.02}
                  step={0.001}
                  value={creditMax}
                  onChange={(e) =>
                    handleCreditMaxChange(parseFloat(e.target.value))
                  }
                />
              </div>

              <div className="range-row">
                <input
                  type="number"
                  step="0.001"
                  value={creditMin}
                  onChange={(e) =>
                    handleCreditMinChange(parseFloat(e.target.value))
                  }
                />
                <span className="to-label">to</span>
                <input
                  type="number"
                  step="0.001"
                  value={creditMax}
                  onChange={(e) =>
                    handleCreditMaxChange(parseFloat(e.target.value))
                  }
                />
              </div>
            </div>

            <div className="toggles">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={showNeighbors}
                  onChange={(e) => setShowNeighbors(e.target.checked)}
                />
                <span>Show neighbors</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={liveUpdate}
                  onChange={(e) => setLiveUpdate(e.target.checked)}
                />
                <span>Live update (auto-refresh)</span>
              </label>
            </div>
          </div>

          <div className="field exp-count-field">
            <label>
              Number of expirations (weekly steps)
              <span className="mini-note">
                &nbsp;1 = base only, up to 3 total.
              </span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                min={1}
                max={3}
                step={1}
                value={numExpirations}
                onChange={(e) =>
                  handleNumExpChange(parseInt(e.target.value, 10))
                }
              />
            </div>
            <div className="range-row">
              <input
                type="number"
                min={1}
                max={3}
                step={1}
                value={numExpirations}
                onChange={(e) =>
                  handleNumExpChange(parseInt(e.target.value, 10))
                }
              />
            </div>
          </div>

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
            Data source: Massive (options & greeks, snapshot/delayed). Backend
            last fetch: <b>{formatTime(lastUpdated)}</b>.
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

                const tableRows: ClassifiedRow[] = sorted.map((row) => {
                  const classification = classifyRow(row);
                  return {
                    ...row,
                    classification,
                    score: scoreForClassification(classification),
                    rowClass: rowClassForClassification(classification),
                  };
                });

                const incompleteCount = data.incomplete.length;
                const isExpanded =
                  expandedIncomplete === data.expiration_date;

                return (
                  <div
                    key={`${data.ticker}-${data.expiration_date}`}
                    className="expiration-block"
                  >
                    <div className="summary-line">
                      <span>
                        Ticker: <b>{data.ticker}</b>
                      </span>
                      <span>
                        Expiration: <b>{data.expiration_date}</b>
                      </span>
                      <span>
                        Spot (approx):{" "}
                        <b>{formatNumber(data.spot_approx, 2)}</b>
                      </span>
                      <span>
                        ATM strike: <b>{data.atm_strike}</b>
                      </span>
                      <span>
                        EM: <b>{formatNumber(data.em, 2)}</b>
                      </span>
                      <span>
                        Lower band: <b>{formatNumber(data.lower_band, 2)}</b>
                      </span>
                    </div>

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
                            <th>Open interest</th>
                            <th>Greeks src</th>
                            <th>Dist. to band</th>
                            <th>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tableRows.length === 0 && (
                            <tr>
                              <td colSpan={10} className="empty-cell">
                                No opportunities for the current filters.
                              </td>
                            </tr>
                          )}

                          {tableRows.map((row) => (
                            <tr
                              key={row.option_ticker}
                              className={row.rowClass}
                            >
                              <td>{row.type}</td>
                              <td>{row.strike_price}</td>
                              <td>{formatNumber(row.delta ?? null, 3)}</td>
                              <td>
                                {formatPercent(row.credit_pct ?? null, 2)}
                              </td>
                              <td>
                                {formatNumber(
                                  row.put_mid ?? row.last ?? null,
                                  2
                                )}
                              </td>
                              <td>{formatInt(row.volume)}</td>
                              <td>{formatInt(row.open_interest)}</td>
                              <td>{row.greeks_source ?? "-"}</td>
                              <td>
                                {formatNumber(
                                  row.distance_to_lower_band ?? null,
                                  2
                                )}
                              </td>
                              <td>{row.score}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {incompleteCount > 0 && (
                      <div className="incomplete-section">
                        <button
                          className="incomplete-toggle"
                          onClick={() =>
                            setExpandedIncomplete((prev) =>
                              prev === data.expiration_date
                                ? null
                                : data.expiration_date
                            )
                          }
                        >
                          {isExpanded ? "▼" : "▶"} {incompleteCount} options with
                          missing delta/IV – click to{" "}
                          {isExpanded ? "collapse" : "expand"}
                        </button>

                        {isExpanded && (
                          <div className="table-wrapper secondary">
                            <table className="data-table small">
                              <thead>
                                <tr>
                                  <th>Strike</th>
                                  <th>Mid (Put)</th>
                                  <th>Volume</th>
                                  <th>Open interest</th>
                                  <th>Credit %</th>
                                  <th>Reason</th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.incomplete.map((row) => (
                                  <tr key={row.option_ticker}>
                                    <td>{row.strike_price}</td>
                                    <td>
                                      {formatNumber(
                                        row.put_mid ?? row.last ?? null,
                                        2
                                      )}
                                    </td>
                                    <td>{formatInt(row.volume)}</td>
                                    <td>{formatInt(row.open_interest)}</td>
                                    <td>
                                      {formatPercent(
                                        row.credit_pct ?? null,
                                        2
                                      )}
                                    </td>
                                    <td>{row.reason_missing}</td>
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
            </>
          )}

          {!error && records.length === 0 && (
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
