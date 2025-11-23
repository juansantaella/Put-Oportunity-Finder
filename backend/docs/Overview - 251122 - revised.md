````markdown

\\# Put Opportunity Finder – Overview



\\## 1. Purpose of the app



Put Opportunity Finder is a small web application that scans \\\*\\\*short put opportunities\\\*\\\* around a statistically–derived \\\*\\\*lower band\\\*\\\* for a given stock and expiration date.



Its main goals are:



\\- Help the user \\\*\\\*quickly locate attractive short puts\\\*\\\* that:

\&nbsp; - Are close to, but below, the lower band.

\&nbsp; - Respect a maximum (absolute) \\\*\\\*delta\\\*\\\*.

\&nbsp; - Provide at least a minimum \\\*\\\*credit %\\\*\\\* relative to spot.

\\- Provide a \\\*\\\*visual, color–coded table\\\*\\\* that distinguishes:

\&nbsp; - The \\\*best\\\* trade(s).

\&nbsp; - Other full matches.

\&nbsp; - Secondary candidates.

\&nbsp; - Neighboring strikes for context.

\\- Allow easy \\\*\\\*profiling\\\*\\\* of risk preferences (Conservative / Normal / Aggressive) while still letting the user fine-tune parameters.



The app is meant as a \\\*\\\*decision-support tool\\\*\\\*, not an execution platform. It helps answer \\\*“Where are the interesting puts this week?”\\\* under a clear set of rules.



---



\\## 2. High-level architecture



\\- \\\*\\\*Backend\\\*\\\*

\&nbsp; - FastAPI application (`backend/main.py`).

\&nbsp; - Exposes a REST endpoint `/rolling-put-candidates/{ticker}` that:

\&nbsp;   - Pulls option chain and underlying data from the configured \\\*\\\*data provider\\\*\\\* (via the `providers` abstraction).

\&nbsp;   - Computes expected move (EM), lower band, and derived metrics.

\&nbsp;   - Flags each put with:

\&nbsp;     - `meets\\\_band` (inside band window),

\&nbsp;     - `meets\\\_delta` (|delta| ≤ max requested),

\&nbsp;     - `meets\\\_credit` (credit % ≥ min requested),

\&nbsp;     - and a `type` (`opportunity`, `neighbor`, `incomplete`).

\&nbsp;   - Returns a structured JSON payload consumed by the frontend.

\&nbsp; - Strategy defaults are read from `backend/strategy\\\_defaults.env` (factory defaults for delta, credit, band distance, and credit ceiling).



\\- \\\*\\\*Frontend\\\*\\\*

\&nbsp; - React + TypeScript + Vite (in `frontend/`).

\&nbsp; - Single page app (`App.tsx`) that:

\&nbsp;   - Renders the \\\*\\\*Control Panel\\\*\\\* and \\\*\\\*Opportunities\\\*\\\* table.

\&nbsp;   - Builds the list of expirations (base + N weekly steps).

\&nbsp;   - Calls the backend with the selected filters.

\&nbsp;   - Applies a second-stage \\\*\\\*classification and scoring\\\*\\\* to the rows for display.



\\- \\\*\\\*Deployment\\\*\\\*

\&nbsp; - Backend served from Render (FastAPI).

\&nbsp; - Frontend served from Netlify (static bundle).

\&nbsp; - The frontend uses `VITE\\\_API\\\_BASE\\\_URL` to know where the backend lives.



---



\\## 3. Control Panel



The \\\*\\\*Control Panel\\\*\\\* at the top of the page controls what the app scans and how strict the filters are.



\\### 3.1 Core inputs



\\- \\\*\\\*Ticker\\\*\\\*

\&nbsp; - Equity or ETF symbol (e.g., `AAPL`, `SPY`).

\&nbsp; - Uppercased automatically.



\\- \\\*\\\*Base expiration (YYYY-MM-DD)\\\*\\\*

\&nbsp; - Anchor expiration date.

\&nbsp; - The app constructs a list of expirations:

\&nbsp;   - Base date.

\&nbsp;   - Plus up to N future weekly expirations (see below).



\\- \\\*\\\*Max Delta (abs)\\\*\\\*

\&nbsp; - Upper bound on the \\\*\\\*absolute\\\*\\\* value of put delta.

\&nbsp; - Example: if set to 0.30, only puts with |Δ| ≤ 0.30 are considered full matches.

\&nbsp; - Slider limits:

\&nbsp;   - Min: \\\*\\\*0.10\\\*\\\*

\&nbsp;   - Max: \\\*\\\*0.50\\\*\\\*

\&nbsp;   - Step: \\\*\\\*0.05\\\*\\\* (0.10, 0.15, 0.20, …, 0.50)

\&nbsp; - Numeric field accepts manual values within that range; they are clamped.



\\- \\\*\\\*Min Credit (%)\\\*\\\*

\&nbsp; - Minimum required credit, expressed as a \\\*\\\*percentage of spot\\\*\\\*.

\&nbsp; - Example: 0.70% means the option must pay at least 0.007 × spot in premium.

\&nbsp; - Internally stored as a \\\*\\\*decimal fraction\\\*\\\* (0.007), but always displayed with two decimals and a `%`.

\&nbsp; - Slider limits:

\&nbsp;   - Min: \\\*\\\*0.30%\\\*\\\*

\&nbsp;   - Max: \\\*\\\*2.00%\\\*\\\*

\&nbsp;   - Step: \\\*\\\*0.05%\\\*\\\*.



\\- \\\*\\\*Distance from lower band (+/- point)\\\*\\\*

\&nbsp; - Defines how far \\\*\\\*above\\\*\\\* the lower band the scan is allowed to go.

\&nbsp; - Example: distance = 3 means the band window is `\\\[lower\\\_band, lower\\\_band + 3]`.

\&nbsp; - Slider:

\&nbsp;   - Min: \\\*\\\*1\\\*\\\*

\&nbsp;   - Max: \\\*\\\*10\\\*\\\*

\&nbsp;   - Step: 1.



\\- \\\*\\\*Number of future expirations (weekly steps)\\\*\\\*

\&nbsp; - Controls how many \\\*\\\*extra weekly expirations\\\*\\\* beyond the base date are scanned.

\&nbsp; - Values:

\&nbsp;   - \\\*\\\*1\\\*\\\* → base expiration only.

\&nbsp;   - \\\*\\\*2\\\*\\\* → base + 1 weekly step.

\&nbsp;   - \\\*\\\*3\\\*\\\* → base + 2 weekly steps.

\&nbsp; - This parameter \\\*\\\*does not change the risk profile\\\*\\\*; it is purely a visibility setting.  

\&nbsp;   Profiles do not reset this value; only the \\\*Factory defaults\\\* button does.



\\### 3.2 Toggles



\\- \\\*\\\*Show neighbors\\\*\\\*

\&nbsp; - If ON, the table includes neighboring strikes around the opportunity window for context.

\&nbsp; - Neighbors are shown with a neutral background.



\\- \\\*\\\*Live update (auto-refresh)\\\*\\\*

\&nbsp; - If ON, the app re-runs the last query automatically every 10 seconds.

\&nbsp; - If OFF, the snapshot is “frozen” until the user presses \\\*Load opportunities\\\* again.



\\### 3.3 Profiles



The app supports \\\*\\\*risk profiles\\\*\\\*:



\\- \\\*\\\*Conservative\\\*\\\*

\&nbsp; - Max Δ: \\\*\\\*0.25\\\*\\\*

\&nbsp; - Min credit: \\\*\\\*0.60%\\\*\\\*

\&nbsp; - Band distance: \\\*\\\*1\\\*\\\*

\&nbsp; - Future expirations: \\\*\\\*1\\\*\\\* (only set when using Factory defaults).



\\- \\\*\\\*Normal (Default)\\\*\\\*

\&nbsp; - Max Δ: \\\*\\\*0.30\\\*\\\*

\&nbsp; - Min credit: \\\*\\\*0.70%\\\*\\\*

\&nbsp; - Band distance: \\\*\\\*1\\\*\\\*

\&nbsp; - Future expirations: \\\*\\\*1\\\*\\\*.



\\- \\\*\\\*Aggressive\\\*\\\*

\&nbsp; - Max Δ: \\\*\\\*0.35\\\*\\\*

\&nbsp; - Min credit: \\\*\\\*0.70%\\\*\\\*

\&nbsp; - Band distance: \\\*\\\*1\\\*\\\*

\&nbsp; - Future expirations: \\\*\\\*1\\\*\\\*.



\\- \\\*\\\*Custom\\\*\\\*

\&nbsp; - Activated automatically when the user changes \\\*\\\*Max Delta\\\*\\\*, \\\*\\\*Min Credit\\\*\\\* or \\\*\\\*Band distance\\\*\\\* away from any profile’s default values.

\&nbsp; - Changing \\\*\\\*Number of future expirations\\\*\\\* does \\\*\\\*not\\\*\\\* force the profile to Custom.



\\\*\\\*Behavior:\\\*\\\*



\\- Clicking a profile button loads its defaults into the relevant controls.

\\- Any manual tweak to Delta, Credit, or Band distance switches the active profile to \\\*\\\*Custom\\\*\\\*.

\\- Clicking \\\*\\\*Factory defaults\\\*\\\*:

\&nbsp; - Applies the \\\*\\\*Normal\\\*\\\* profile.

\&nbsp; - Resets \\\*\\\*Number of future expirations\\\*\\\* to 1.

\&nbsp; - Effectively returns the app to its “factory” state.



---



\\## 4. How filtering works



When the user clicks \\\*\\\*Load opportunities\\\*\\\*:



1\\. The frontend builds a `QueryParams` object with:

\&nbsp;  - `ticker`

\&nbsp;  - `expiration\\\_date` (base)

\&nbsp;  - `delta\\\_min` (fixed lower bound, currently 0.10)

\&nbsp;  - `delta\\\_max` (from Max Delta control)

\&nbsp;  - `credit\\\_min\\\_pct` (from Min Credit control)

\&nbsp;  - `credit\\\_max\\\_pct` (fixed at 0.02 = 2.0%)

\&nbsp;  - `band\\\_window` (from Distance control)

\&nbsp;  - number of expirations (from Future expirations control).



2\\. It builds the actual list of expirations (base + weekly steps).



3\\. For each expiration, the backend:

\&nbsp;  - Computes \\\*\\\*spot approx\\\*\\\*, \\\*\\\*ATM strike\\\*\\\*, \\\*\\\*expected move (EM)\\\*\\\* and \\\*\\\*lower band\\\*\\\*.

\&nbsp;  - Filters valid puts and flags:

\&nbsp;    - `meets\\\_band`

\&nbsp;    - `meets\\\_delta`

\&nbsp;    - `meets\\\_credit`

\&nbsp;    - `type` (`opportunity`, `neighbor`, `incomplete`).

\&nbsp;  - Returns:

\&nbsp;    - `opportunities` (rows with full data),

\&nbsp;    - `neighbors` (context rows),

\&nbsp;    - `incomplete` (missing greeks/metrics).



4\\. The frontend merges `opportunities` + (optional) `neighbors`, sorts by strike, and performs a \\\*\\\*second-stage classification\\\*\\\* for display.



---



\\## 5. Table classification \\\& colors



For each row, the frontend assigns a `classification` and a `score` symbol:



\\- \\\*\\\*First pass – rule-based classification:\\\*\\\*



\&nbsp; ```text

\&nbsp; neighbor            → neighbor (always neutral)

\&nbsp; not meets\\\_band      → neighbor (defensive fallback)

\&nbsp; meets\\\_band + delta + credit → opportunity

\&nbsp; meets\\\_band + (delta XOR credit) → candidate\\\_strong

\&nbsp; meets\\\_band only     → candidate

````



\* \*\*Second pass – “best” detection:\*\*



  \* Among rows classified as `opportunity` (full match), the app finds the \*\*maximum credit %\*\*.

  \* Any full match with that maximum credit is upgraded to `best`.



\* \*\*Score symbols:\*\*



  \* `best` → \*\*★\*\* (BEST: meets band + delta + credit and has the highest credit % for that expiration).

  \* `opportunity` → \*\*✓\*\* (full matches that are not the absolute best).

  \* `candidate\\\_\\\*` and `neighbor` → empty score cell (no symbol).



\* \*\*Row colors (CSS classes):\*\*



  \* `.row-best` → highlighted (primary green background).

  \* `.row-opportunity` → “opportunity” color (secondary highlight).

  \* `.row-candidate` → lighter alert color (band only).

  \* `.row-neighbor` → neutral background.



Each expiration block shows:



\* Header line with:



  \* Ticker

  \* Expiration date

  \* Spot (approx)

  \* ATM strike

  \* EM

  \* Lower band

\* Main table with:



  \* Type

  \* Strike

  \* Delta

  \* Credit %

  \* Mid (put)

  \* Volume

  \* Open interest

  \* Greeks source

  \* Distance to band

  \* Score

\* \*\*Incomplete section\*\* (optional):



  \* A collapsible sub-table listing rows with missing greeks or other data.

  \* Helps explain why some strikes are not in the main opportunities table.



At the bottom of the Opportunities section, the app shows a compact \*\*Profile summary\*\* line:



> `Profile: Normal · Max Δ: 0.30 · Min credit: 0.70% · Band distance: 1 · Future expirations: 1`



---



\## 6. Data source indicator



Above the Opportunities card, the app displays the current \*\*data source\*\*, derived from the backend’s `data\\\_provider` value:



Examples:



\* `Tradier (sandbox / paper)`

\* `Tradier (live)`

\* `Massive (options \\\& greeks, snapshot/delayed)`

\* `Yahoo Finance (delayed / informational)`



If the frontend cannot determine the provider, it shows a generic “Unknown (check backend)”.



This indicator is important for documentation and testing, as it clarifies whether the user is seeing paper/sandbox data or live market data.



---



\## 7. Intended usage pattern



A typical workflow:



1\. Choose a \*\*ticker\*\* and \*\*base expiration\*\* (usually the nearest weekly).

2\. Select a \*\*profile\*\* (Conservative / Normal / Aggressive).

3\. Optionally:



   \* Adjust \*\*Max Delta\*\*, \*\*Min Credit\*\*, or \*\*Band distance\*\* to match personal risk tolerance.

   \* Increase \*\*Number of future expirations\*\* to see base + 1–2 extra weeks.

4\. Click \*\*Load opportunities\*\*.

5\. Review the tables:



   \* Focus first on \*\*★\*\* (“best”) rows.

   \* Then consider \*\*✓\*\* rows and strong candidates, depending on how strict you want to be.

6\. If needed, tighten or loosen filters (delta/credit) and reload.



The app is deliberately designed to avoid micromanagement of parameters and to emphasise \*\*consistency\*\* and \*\*readability\*\* of the resulting opportunity set.



---



\## 8. Notes and future extensions



Some ideas for future iterations:



\* \*\*Tooltips / legends\*\* explaining the color scheme and symbols.

\* Export options (CSV/JSON) for selected rows.

\* Saving \*\*user profiles\*\* (e.g., personal presets beyond the three built-in profiles).

\* Supporting additional providers under the same `providers` abstraction without changing the UI.



For now, this overview should be enough to understand what the app does, how it is structured, and how each control affects the resulting list of put opportunities.



```

```

