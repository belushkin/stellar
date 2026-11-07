# Stellar DEX Trading Scanner

Read-only Stellar DEX market scanner and paper-trading project. It needs no
wallet or secret key and never signs or submits transactions.

## Requirements

- Node.js 22.12 or newer
- npm

## Setup

```sh
npm install
cp .env.example .env
set -a
. ./.env
set +a
npm run typecheck
npm test
npm start
```

Docker (Node.js 22.12):

```sh
docker build -t stellar-dex-trading-scanner .
docker run --rm --env-file .env \
  -v stellar-scanner-data:/app/data \
  stellar-dex-trading-scanner
```

For a persistent background run, use the helper script instead of managing
Docker commands manually:

```sh
chmod +x scripts/stellar.sh
./scripts/stellar.sh check
./scripts/stellar.sh start
./scripts/stellar.sh status
./scripts/stellar.sh logs --follow --since 10m
./scripts/stellar.sh report observation-report.json
./scripts/stellar.sh replay replay-summary.json
./scripts/stellar.sh stop
```

`start` creates a container with the `unless-stopped` restart policy and the
persistent `stellar-scanner-data` volume. Use `restart` to restart it with its
current configuration, or `recreate` to rebuild and apply current source and
`.env` changes while preserving the database volume. `status` shows the
container state and recent output. The script only manages the observation-mode
scanner; it does not enable paper or live order placement.
`report` can run while the scanner is collecting or after it is stopped. With
no filename it prints JSON to standard output; with a filename it saves the
report on the host. It opens the SQLite database read-only and evaluates the
report in a consistent read transaction. Reports generated mid-run include
only data committed by the report's snapshot time; pending markouts and
incomplete observations are expected until their horizons mature or any data
gaps are resolved.

`replay` builds a one-off container from the current source and attaches the
scanner's data volume without stopping the scanner. It reads a consistent
snapshot of persisted market inputs and writes only to the separate historical
replay tables. Repeating the command with unchanged inputs is idempotent; new
source data or a new model version creates a distinct replay run. The report
includes the latest replay run and its data-quality counts.

## Market data and asset identity

The app validates configuration, initializes SQLite, checks the public Horizon
endpoint, and retrieves live order books for configured pairs. It persists each
snapshot and its integrity status, logs best bid and ask, spread, full-book
depth, and local receipt time, and monitors freshness. Horizon's SDK
`OrderbookCallBuilder` is used for both snapshots and its SSE stream.

Set `STELLAR_PAIRS` to a JSON array of `{ "base": ..., "quote": ... }` entries.
Use `{ "type": "native" }` for XLM and
`{ "type": "credit", "code": "<asset code>", "issuer": "<issuer G...>" }` for a
credit asset. Each credit asset requires an exact `CODE:ISSUER` entry in
`STELLAR_TRUSTED_ASSET_DOMAINS`. At startup, the app verifies that Horizon
recognizes that code and issuer, that the issuer account matches, and that its
on-chain home domain matches the configured trusted domain. This verifies asset
identity only; it does not prove a credit asset's peg or economic quality. For
example:

```sh
STELLAR_PAIRS='[{"base":{"type":"native"},"quote":{"type":"credit","code":"<asset code>","issuer":"<verified issuer G...>"}}]'
STELLAR_TRUSTED_ASSET_DOMAINS='{"<asset code>:<verified issuer G...>":"<trusted issuer domain>"}'
STELLAR_PAPER_MAX_DAILY_LOSS_BY_QUOTE='{"<asset code>:<verified issuer G...>":"25"}'
```
Replace both placeholders with the asset code and verified Stellar issuer key.
Set a positive daily loss limit for every configured quote asset. Limits are
tracked independently in each quote asset; they are not aggregated across
unvalidated conversion rates.
For each credit quote asset, also configure an XLM/quote pair; its fresh direct
book is required to validate simulated network-fee conversion.

The scanner uses the order book returned by Horizon as-is. One-sided, crossed,
or locked books cannot produce a positive passive-maker signal; unusual but
protocol-valid levels should still be reviewed as market data, not assumed
executable liquidity.

At most four pairs may be streamed on the default public Horizon endpoint.
Horizon counts stream updates against its per-IP rate limit, so use a separately
provisioned Horizon provider if the scanner needs more pairs.

Amounts are aggregated from the actual book levels. Spread percentage is
relative to the bid/ask midpoint. Executable-volume estimates walk the relevant
side of the book, report partial depth, quote amount, VWAP, and adverse
slippage; they do not extrapolate beyond displayed liquidity. Decimal arithmetic
is used instead of JavaScript floating-point amounts.

## Signals and observation-only mode

The scanner evaluates passive buy candidates at the best bid and sell
candidates at the best ask. It reports displayed spread only as a screening
metric. Every signal is associated with its immutable order-book snapshot and
strategy/model version. Limit-price scenarios are hypothetical: they do not
create paper orders, reserve balances, or change portfolio balances. The runner
does not call the paper-trading engine and will remain in observation mode until
execution evidence has been independently validated.

Positive expected net profit requires fresh historical model evidence for fill
fractions, post-fill markouts, other trading costs, and opportunity costs, plus
matching pair/side and portfolio state. The runner therefore fails closed with
`insufficient_data` rather than emitting positive signals or placing orders
based on an assumed fill or displayed spread.
Inventory risk is charged using the configured basis-point assumption; evidence
sample count, age, spread/liquidity/slippage/profit thresholds, order size,
inventory cap, and replacement count are configurable through `.env.example`.

## Historical market and execution evidence

Order-book snapshots are stored with local receive timestamps, source, a
per-pair receive sequence, content hash, and integrity results. Horizon trade
prints preserve ledger-close time and local receive time, paging cursor, source,
and validation status. Duplicate trade IDs are ignored; malformed amounts,
prices, or future timestamps are quarantined. The durable cursor advances only
after the event is persisted. On restart or reconnect, the runner requests
paginated Horizon trade history from the last committed cursor before resuming
the stream. Reconnect and recovery failures are recorded as data gaps; gaps
remain visible until a successful backfill covers them.

Execution evidence separates exact-limit public trade volume from volume that
traded through the hypothetical price. Only matching-side order-book trades
after hypothetical placement are considered. Displayed queue volume plus a
conservative hidden-queue allowance produces lower and upper estimated fill
bounds. These are scenario bounds, not evidence that this scanner's order
executed. A price touch, public trade, or estimated fill is never reported as an
actual fill.
Each hypothetical order has a 60-minute observation window. A no-fill result is
counted only after that window closes with no unresolved stream gap and a trade
cursor available at placement; otherwise it remains incomplete. Fill and
partial-fill probability outputs are conservative bounds implied by the queue
interval, not a statistically calibrated forecast.

Markouts are created only for the conservative lower-bound estimated fill and
are evaluated at 1, 5, 15, and 60 minutes. They use executable liquidation
depth rather than midpoint prices. Missing, stale, invalid, or insufficient
book depth leaves the markout incomplete; unavailable fee conversion also
prevents a complete net markout. Markout and performance summaries are kept per
pair and strategy so unlike quote assets are never aggregated.

The historical replay engine is a separate research workflow. It creates a
counterfactual scenario for persisted `positive` and `insufficient_data`
decisions without changing the decision or hypothetical-order status. It never
calls the paper-trading engine and cannot submit transactions. Results use
`independent_counterfactual` mode: scenarios may examine the same public trade,
so scenario fills and markouts must not be added together as portfolio P&L.
Portfolio-wide allocation across overlapping scenarios is not implemented.

Replay uses local receive order for snapshots and trades, with the trade event
timestamp and paging cursor as additional guards. Horizon order-book snapshots
do not include a comparable exchange event timestamp or ledger sequence, so
cross-stream ordering and queue changes are explicitly marked uncertain where
they cannot be reconstructed. It tracks visible queue bounds, treats
cancellations and newly joined liquidity conservatively, and never treats a
price touch or a public trade as proof of the scanner's execution. It also
requires snapshot coverage through each scenario's expiry; snapshot intervals
over five minutes are classified as data gaps. Reported fill fractions are
scenario outcome bounds, not statistically calibrated probabilities.

Replay markouts are recorded separately at 5 seconds, 30 seconds, 1 minute,
5 minutes, and 15 minutes. They use the modeled fill price, separate initial
spread capture from subsequent midpoint movement, and value liquidation using
opposite-side executable depth. Sampling delay, fees, and missing depth are
reported per horizon. These are modeled counterfactual results, not paper
fills or realized trading performance.

Portfolio risk valuations use executable liquidation prices, known lot cost
basis, same-day realized P&L, and simulated costs. Missing or stale books,
insufficient liquidation depth, unknown basis, or incomplete fee conversion
produce an incomplete valuation; they are not treated as zero P&L. The paper
engine's daily-loss guard also includes unrealized liquidation P&L and fails
closed when exposure cannot be valued. In the current runner, valuations are
observation/reporting only and do not trigger trades.

Fee estimates use Horizon's current fee statistics (the greater of the
last-ledger base fee and recent charged-fee p95) in stroops per operation. For
credit quote assets, the estimated XLM cost is converted only with a fresh,
validated direct XLM/quote book and conversion path. These are simulated
research costs, not fees paid on Stellar.

Reports include signal outcomes and rejection reasons, conservative estimated
fill and partial-fill bounds, markout distributions, per-pair/strategy
performance, inventory exposure, valuation completeness, and drawdown. P&L
remains denominated per quote asset.

The paper-trading engine remains available as a separately tested simulation
component, but the scanner runner does not invoke it. In observation mode,
`STELLAR_PAPER_INITIAL_BALANCES` is not used to seed balances and
`STELLAR_PAPER_EMERGENCY_STOP` does not affect public data collection. Any
future paper execution enablement must be a separately approved step after
execution evidence is validated. The project still has no wallet or secret-key
setting, pays no fees, and has no transaction signing or submission path.

Horizon responses include a latest-ledger header, but the SDK's order-book
record/stream interfaces do not expose that header or the HTTP response time.
This milestone therefore timestamps snapshots at local receipt and leaves
`latestLedger` unset; freshness is based on that receive timestamp, not a claim
about the ledger's age.

No wallet or secret-key setting exists. The program has no transaction
signing, transaction submission, or real-trading path.
