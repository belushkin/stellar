# Stellar DEX Trading Opportunity Audit

**Audit date:** 2026-11-08  
**Scope:** Read-only review of the repository, configured pair, saved observation
report, and existing isolated offer-ledger POC artifacts. No collector or
database was started, stopped, or modified.

## Executive decision: STOP

There is no credible, evidence-supported path to positive net returns in the
data currently available in this workspace. The configured SQLite database
(`./data/stellar-scanner.sqlite`) is absent, so the persisted snapshot, trade,
gap, signal, and replay tables could not be inspected. The one saved
observation report records 336 signals, all `insufficient_data`, with zero
execution scenarios, no fill-rate bounds, no markout samples, and no
performance rows. It is not evidence of profitable trading.

There are 14 saved XLM/USDC order-book snapshots from isolated ledger research
runs. Their mid-relative displayed spreads range from 0.060154% to 0.143162%
(median 0.094649%). They are clustered endpoints of selected experiments,
not a continuous or representative time series. They do not establish spread
persistence, executable fill probability, adverse selection, or net returns.
Seven of those runs include an independent book validation result; only three
pass, while four have 39 reported mismatches in total. These artifacts are not
a strategy backtest.

If this were my own money and engineering time, I would stop investing in
strategy and infrastructure work on the current evidence. This does not prove
that Stellar DEX is unprofitable; it means this project has not demonstrated
an edge, and its available data cannot establish one. The cheapest next step
is to locate an already-existing database copy and audit it read-only. If none
exists, do not build a new ingestion system merely to keep this strategy
research alive.

## 1. Available data inventory

### Configured market

The local `.env` configures one pair: XLM / USDC, with USDC issuer
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. The configured
database path is `./data/stellar-scanner.sqlite`. The path does not exist in
this workspace. No SQLite database file was found in the repository. The
collector was not run to create one.

Therefore the following requested inventory metrics are **unavailable, not
zero**:

| Metric | Finding |
|---|---|
| Persisted SQLite date range and snapshot count | Unavailable: configured database absent |
| Trades, duplicate/conflicting trade rows, and trade-type coverage | Unavailable: configured database absent |
| Valid/rejected/quarantined observation counts | Unavailable: configured database absent |
| Per-pair coverage, snapshot gaps, and stream reconnects | Unavailable: configured database absent |
| Stored signal history and replay scenario rows | Unavailable: configured database absent |
| Historical executable-depth, fee, and portfolio-P&L series | Unavailable: configured database absent |

### Saved observation report

The pre-existing, untracked [`report.json`](../report.json) was read but not
modified. It was generated at **2026-11-07 20:47:37.303 UTC** and contains:

| Measure | Saved value |
|---|---:|
| Signals generated | 336 |
| Positive / rejected / insufficient-data signals | 0 / 0 / 336 |
| `passive_fill_and_markout_evidence_unavailable` | 336 decisions |
| `spread_below_minimum` | 226 decisions |
| `insufficient_base_inventory` / `insufficient_quote_balance` | 168 / 168 decisions |
| `trade_stream_unavailable` | 4 decisions |
| Execution scenarios / observed scenarios | 0 / 0 |
| Fill-rate and fill-probability bounds | Null |
| Markout distributions / performance rows | 0 / 0 |
| Historical replay summary | Null |

Rejection-reason counts are not mutually exclusive. The report's single
portfolio-risk row displays zero P&L, drawdown, and exposure with status
`complete`; in the absence of a backing database and any execution scenarios,
those zeros are not measured trading performance and must not be interpreted
as such.

### Isolated order-book research artifacts

The workspace contains seven XLM/USDC offer-ledger POC runs with two saved
Horizon book endpoints each: **14 snapshots total**, each capped at 200 levels
per side. Their capture times span **2026-11-07 23:13:52.640 UTC** to
**2026-11-08 17:29:31.336 UTC**. The median time between adjacent captures is
84.418 seconds; the maximum is **64,939.771 seconds** (about 18 hours).
Captures are selected POC endpoints, not regular scanner observations, so
these gaps do not describe the collector's normal snapshot cadence.

For descriptive context only, calculating `(best ask - best bid) / midpoint`
from those saved book endpoints gives:

| XLM/USDC endpoint snapshots | Min | Median | Max | Below configured 0.1% threshold |
|---:|---:|---:|---:|---:|
| 14 | 0.060154% | 0.094649% | 0.143162% | 8 of 14 |

The sample is clustered into a few short windows plus an approximately
18-hour gap, and was collected for ledger-replay research rather than sampled
to estimate a trading distribution. It cannot support spread persistence,
spread capture, or statistical confidence claims.

The seven POC runs cover separate continuous ledger ranges from
65,361,437–65,361,439 through 65,374,565–65,374,585; the ranges are not
continuous with one another. The POC's offer-state-versus-Horizon validation
passes for three runs and fails for four, with **39 reported mismatches** in
the failing runs. In three runs the POC records a counterfactual estimate;
that is not an observed fill or evidence that a hypothetical order would
have executed. One additional isolated run covers LIL/XLM, but it does not
provide a second liquid market or a comparable cross-market time series.

These are offer-ledger replay artifacts, not market trade-history rows. The
repository has no saved trade-print dataset available for this audit.

## 2. What the implementation can record—and what is missing

The codebase has a suitable schema for future observations:

- `market_snapshots` can store pair, local receive time, `latest_ledger`,
  order-book JSON, integrity result, source, and sequence.
- `market_trades` can store the pair, cursor, ledger-close time, base amount,
  rational price numerator/denominator, base-seller direction, trade type,
  receive time, validation result, and optional offer/account/operation/
  transaction identifiers.
- `market_stream_sessions` and `market_data_gaps` record stream state and
  detected/recovered/unrecoverable gaps.
- `strategy_decisions`, `research_execution_scenarios`,
  `research_execution_events`, and `research_markout_observations` separate
  signals, hypothetical evidence, and markouts.

Relevant implementation: [`database.ts`](../src/storage/database.ts#L84),
[`market-store.ts`](../src/storage/market-store.ts#L62),
[`trade-source.ts`](../src/market-data/trade-source.ts#L199), and
[`market-observation.ts`](../src/observation/market-observation.ts#L345).

Important limitations:

1. The persisted order-book type sets `latestLedger` to `null`; snapshot
   normalization records local `receivedAtMs`, not a source event time.
   `recordMarketSnapshot` writes `source_timestamp_ms` as null.
   See [`types.ts`](../src/order-book/types.ts#L24),
   [`normalize.ts`](../src/order-book/normalize.ts#L82), and
   [`market-store.ts`](../src/storage/market-store.ts#L62).
2. The order-book source fetches an initial Horizon book and then consumes
   Horizon's order-book stream. It persists on updates, not on a configured
   periodic polling schedule. Silence or stream gaps therefore cannot be
   interpreted as unchanged market state without the associated stream
   session and gap evidence.
3. Trade `occurredAtMs` is parsed from Horizon's `ledger_close_time`.
   Trade records include rational price, amount, direction, trade type, and
   optional identifiers, but public trade volume is not our order's execution.
   Multiple trades in one ledger share ledger-close-time granularity, so that
   timestamp cannot establish their precise ordering against local order-book
   stream receipt.
4. The replay engine orders cross-stream events using local receive time,
   applies a trade-time guard, and explicitly flags ambiguous ordering,
   stale/gapped snapshots, and through-price counterfactual fills. Its
   calculated lower/upper fills remain modeled estimates, not actual fills.
   See [`historical-replay-engine.ts`](../src/observation/historical-replay-engine.ts#L310)
   and [`historical-replay-engine.ts`](../src/observation/historical-replay-engine.ts#L730).
5. The passive-maker signal requires measured fill/markout evidence and
   minimum samples before expected net profit can be calculated. Without
   evidence it returns `insufficient_data`, not a positive signal.
   See [`passive-maker.ts`](../src/strategies/passive-maker.ts#L244).
6. Historical order-book levels are capped by the Horizon order-book endpoint;
   individual offer identities and queue position are not present in the
   aggregate snapshot.

### Reproducible read-only SQLite inventory

These queries are provided for an existing database copy only. They were **not
run** because the configured database file is absent. Open SQLite in read-only
mode and use one read transaction; do not run the application or its
schema-creating `openDatabase` function for this audit.

```sql
BEGIN;

-- Snapshot coverage and integrity by pair.
SELECT p.pair_id,
       COUNT(s.id) AS snapshots,
       MIN(datetime(s.received_at_ms / 1000, 'unixepoch')) AS first_received_utc,
       MAX(datetime(s.received_at_ms / 1000, 'unixepoch')) AS last_received_utc,
       SUM(CASE WHEN s.integrity_status = 'valid' THEN 1 ELSE 0 END) AS valid,
       SUM(CASE WHEN s.integrity_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
FROM trading_pairs AS p
LEFT JOIN market_snapshots AS s ON s.pair_id = p.pair_id
GROUP BY p.pair_id
ORDER BY p.pair_id;

-- Snapshot gaps, computed from received time (not market event time).
WITH ordered AS (
  SELECT pair_id, received_at_ms,
         LAG(received_at_ms) OVER (
           PARTITION BY pair_id ORDER BY received_at_ms, id
         ) AS previous_ms
  FROM market_snapshots
)
SELECT pair_id, COUNT(*) AS gaps_over_5m,
       MAX(received_at_ms - previous_ms) AS max_gap_ms
FROM ordered
WHERE previous_ms IS NOT NULL AND received_at_ms - previous_ms > 300000
GROUP BY pair_id;

-- Trade coverage and validation by pair/type.
SELECT pair_id, trade_type, validation_status, COUNT(*) AS trades,
       MIN(datetime(occurred_at_ms / 1000, 'unixepoch')) AS first_event_utc,
       MAX(datetime(occurred_at_ms / 1000, 'unixepoch')) AS last_event_utc
FROM market_trades
GROUP BY pair_id, trade_type, validation_status
ORDER BY pair_id, trade_type, validation_status;

-- Stream gaps and reconnect/session history.
SELECT pair_id, source, status, COUNT(*) AS records,
       MIN(datetime(detected_at_ms / 1000, 'unixepoch')) AS first_detected_utc,
       MAX(datetime(detected_at_ms / 1000, 'unixepoch')) AS last_detected_utc
FROM market_data_gaps
GROUP BY pair_id, source, status
ORDER BY pair_id, source, status;

SELECT pair_id, source, status, COUNT(*) AS sessions,
       MIN(datetime(started_at_ms / 1000, 'unixepoch')) AS first_started_utc,
       MAX(datetime(ended_at_ms / 1000, 'unixepoch')) AS last_ended_utc
FROM market_stream_sessions
GROUP BY pair_id, source, status
ORDER BY pair_id, source, status;

-- Persisted replay classifications and markout coverage.
SELECT pair_id, status, evidence_quality, confidence, COUNT(*) AS scenarios
FROM research_execution_scenarios
GROUP BY pair_id, status, evidence_quality, confidence
ORDER BY pair_id, status;

SELECT horizon_seconds, status, COUNT(*) AS markouts
FROM research_markout_observations
GROUP BY horizon_seconds, status
ORDER BY horizon_seconds, status;

ROLLBACK;
```

## 3. Trading hypothesis assessment

### A. Passive spread capture — not established

The 14 selected endpoints show displayed spreads around one tenth of one
percent, with eight below the configured 0.1% minimum. Even a spread above
that threshold is only a displayed price difference. A passive order must
first be accepted, wait behind existing liquidity, receive executions, and
then exit; the exit can incur spread crossing, depth slippage, adverse
selection, inventory cost, and fees. A price touch or public trade at a price
does not prove execution of our hypothetical order.

The current data has no measured queue-aware fill distribution and no actual
fills. The existing replay's queue bounds rely on aggregate snapshots and
public trade prints, with explicit ambiguity handling. No fill probability
can be estimated from the saved evidence, so expected spread-capture return
is **not estimable**.

### B. Short-term momentum — not testable

There is no accessible, persisted trade-print series or continuous,
ledger-aligned sequence of executable prices. The 14 research snapshots are
too sparse and selected to test whether trade direction or recent activity
predicts subsequent executable prices. No out-of-sample or net-cost result is
available.

### C. Mean reversion — not testable

The data does not contain a sufficiently dense, continuous price history from
which to identify shocks, measure reversal timing, or avoid overlapping
samples. No reversal frequency or magnitude can be reported.

### D. Cross-market opportunities — not supported

The configured scanner monitors only XLM/USDC. The isolated LIL/XLM ledger
POC is not a time series and does not establish liquidity, reliable
conversion, synchronized prices, or executable cross-market routes.
USDC and XLM are not interchangeable quote assets; no completed conversion
cycle can be evaluated from the available observations.

### E. Taker/arbitrage strategies — no credible test

An order-book snapshot can estimate immediate executable volume and slippage
for a specified size at that instant. But there is no persisted historical
book series or multi-market state here, and no evidence that a signal could
be acted on before it disappeared. The first 200 levels also do not expose
the full tail. A one-time depth estimate would not establish a repeatable
positive expected return.

## 4. Economic and statistical assessment

No gross return, net return, turnover, trading frequency, capital
requirement, or confidence interval can be estimated from the accessible
dataset. In particular:

- **Observed facts:** 14 sampled XLM/USDC books and the saved report values
  above; the books have displayed spreads and aggregate depth at capture.
- **Statistical estimates:** none. Fourteen selected observations are not a
  representative sample and are clustered in time.
- **Counterfactual assumptions:** ledger POC outputs labelled “estimated”
  are scenario/model outputs, not executed orders. No such output is counted
  as a fill or P&L.
- **Unknown:** actual market trade counts and distributions, true passive
  queue position, fill probability, partial-fill rate, adverse selection,
  historical fees/conversion rates, and executable exit costs.

Displayed spread is not net profit. Even with a fill, a round trip would need
to subtract network transaction costs (and the cost of converting XLM fees
into USDC where applicable), slippage on the exit, inventory risk, and
adverse selection. The implementation can estimate current fees and
conversion paths, but the audit has no historical fee series or execution
records with which to validate those costs. A positive expected return must
not be inferred by assuming fills at the touch.

There is no chronological train/test split to perform. Survivorship and
selection bias are severe: only one configured pair is available, the POC
snapshots were selected for ledger experiments, and the sample includes a
large observation gap. Overlapping-sample inflation and regime stability
cannot be tested. Synthetic unit tests validate code paths, not a market
edge.

## 5. Engineering effort versus opportunity

The project already contains substantial market integrity, gap tracking,
trade validation, fee estimation, risk checks, and conservative replay
logic. Those mechanisms improve correctness but cannot compensate for a
missing dataset or establish profitability. The persisted report demonstrates
that the signal implementation fails closed without fill/markout evidence.

Further strategy code, more elaborate replay models, or new ingestion
infrastructure would add engineering cost before the necessary basic
empirical inputs are available. Given zero positive signals, zero replay
scenarios/markouts in the saved report, and no accessible source database,
the expected information gain does not justify that work.

## 6. Recommended next step

**Stop strategy and infrastructure development.** If an existing SQLite
database copy is available outside this workspace, provide or mount that copy
read-only and run the inventory SQL above before considering any new work.
Proceed only if it contains a continuous, sufficiently long XLM/USDC history
of validated snapshots and trades, with gap records and enough matured
outcomes to evaluate execution costs. If no such pre-existing data exists,
do not build a new collection pipeline solely to keep this trading thesis
alive.

No trading, paper execution, wallet integration, signing, or transaction
submission is authorized or recommended by this audit.
