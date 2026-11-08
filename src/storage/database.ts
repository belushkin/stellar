import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

const INITIAL_SCHEMA_VERSION = 1;
const PAPER_TRADING_SCHEMA_VERSION = 2;
const PAPER_DEPTH_SCHEMA_VERSION = 3;
const MARKET_OBSERVATION_SCHEMA_VERSION = 4;
const HISTORICAL_REPLAY_SCHEMA_VERSION = 5;
const HISTORICAL_REPLAY_DETAILS_SCHEMA_VERSION = 6;
const HORIZON_METADATA_AND_MARKOUT_REFERENCE_SCHEMA_VERSION = 7;

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  database.transaction(() => {
    const hasInitialMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(INITIAL_SCHEMA_VERSION);

    if (hasInitialMigration === undefined) {
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(INITIAL_SCHEMA_VERSION, new Date().toISOString());
    }
  })();

  database.transaction(() => {
    const hasPaperTradingMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(PAPER_TRADING_SCHEMA_VERSION);

    if (hasPaperTradingMigration !== undefined) {
      return;
    }

    database.exec(`
      CREATE TABLE assets (
        asset_id TEXT PRIMARY KEY,
        asset_type TEXT NOT NULL CHECK (asset_type IN ('native', 'credit')),
        code TEXT,
        issuer TEXT,
        home_domain TEXT,
        validation_status TEXT NOT NULL DEFAULT 'unverified'
          CHECK (validation_status IN ('unverified', 'verified', 'rejected')),
        validated_at_ms INTEGER,
        validation_error TEXT,
        CHECK (
          (asset_type = 'native' AND asset_id = 'native' AND code IS NULL AND issuer IS NULL)
          OR
          (asset_type = 'credit' AND code IS NOT NULL AND issuer IS NOT NULL
            AND asset_id = code || ':' || issuer)
        )
      );

      CREATE TABLE trading_pairs (
        pair_id TEXT PRIMARY KEY,
        base_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        quote_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        UNIQUE (base_asset_id, quote_asset_id),
        CHECK (base_asset_id <> quote_asset_id)
      );

      CREATE TABLE market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        received_at_ms INTEGER NOT NULL,
        latest_ledger TEXT,
        snapshot_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        integrity_status TEXT NOT NULL CHECK (integrity_status IN ('valid', 'rejected')),
        validation_reasons_json TEXT NOT NULL
      );
      CREATE INDEX market_snapshots_pair_time
        ON market_snapshots(pair_id, received_at_ms DESC);

      CREATE TABLE market_trades (
        trade_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        cursor TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        base_amount TEXT NOT NULL,
        price_numerator TEXT NOT NULL,
        price_denominator TEXT NOT NULL,
        base_is_seller INTEGER NOT NULL CHECK (base_is_seller IN (0, 1)),
        trade_type TEXT NOT NULL
      );
      CREATE INDEX market_trades_pair_time ON market_trades(pair_id, occurred_at_ms);

      CREATE TABLE stream_cursors (
        pair_id TEXT PRIMARY KEY REFERENCES trading_pairs(pair_id),
        trade_cursor TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE strategy_decisions (
        decision_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        status TEXT NOT NULL CHECK (status IN ('positive', 'rejected', 'insufficient_data')),
        reasons_json TEXT NOT NULL,
        evidence_json TEXT,
        fee_estimate_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX strategy_decisions_pair_time
        ON strategy_decisions(pair_id, created_at_ms DESC);

      CREATE TABLE paper_portfolios (
        portfolio_id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE paper_balances (
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        available TEXT NOT NULL,
        reserved TEXT NOT NULL,
        PRIMARY KEY (portfolio_id, asset_id)
      );

      CREATE TABLE paper_orders (
        order_id TEXT PRIMARY KEY,
        client_order_key TEXT NOT NULL UNIQUE,
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        decision_id TEXT REFERENCES strategy_decisions(decision_id),
        order_type TEXT NOT NULL CHECK (order_type IN ('limit', 'marketable_limit')),
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        limit_price TEXT NOT NULL,
        requested_base TEXT NOT NULL,
        filled_base TEXT NOT NULL,
        remaining_base TEXT NOT NULL,
        queue_ahead_base TEXT NOT NULL,
        queue_consumed_base TEXT NOT NULL,
        fee_operation_stroops TEXT NOT NULL,
        fee_quote_per_xlm TEXT,
        fee_conversion_snapshot_id INTEGER REFERENCES market_snapshots(id),
        reserved_fee_xlm TEXT NOT NULL,
        fee_operations_remaining INTEGER NOT NULL,
        max_replacements INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'paused')
        ),
        placement_snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX paper_orders_open
        ON paper_orders(portfolio_id, pair_id, status);

      CREATE TABLE paper_order_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES paper_orders(order_id),
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        snapshot_id INTEGER REFERENCES market_snapshots(id),
        trade_id TEXT REFERENCES market_trades(trade_id),
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX paper_order_events_order_time
        ON paper_order_events(order_id, created_at_ms);

      CREATE TABLE paper_fills (
        fill_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES paper_orders(order_id),
        trade_id TEXT REFERENCES market_trades(trade_id),
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('trade', 'book_depth')),
        base_amount TEXT NOT NULL,
        price TEXT NOT NULL,
        quote_amount TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX paper_fills_order_trade
        ON paper_fills(order_id, trade_id) WHERE trade_id IS NOT NULL;

      CREATE TABLE paper_trade_allocations (
        trade_id TEXT NOT NULL REFERENCES market_trades(trade_id),
        order_id TEXT NOT NULL REFERENCES paper_orders(order_id),
        queue_consumed_base TEXT NOT NULL,
        filled_base TEXT NOT NULL,
        PRIMARY KEY (trade_id, order_id)
      );

      CREATE TABLE paper_ledger_entries (
        entry_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        bucket TEXT NOT NULL CHECK (bucket IN ('available', 'reserved')),
        amount TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX paper_ledger_portfolio_asset
        ON paper_ledger_entries(portfolio_id, asset_id, created_at_ms);

      CREATE TABLE paper_fee_entries (
        fee_entry_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES paper_orders(order_id),
        event_type TEXT NOT NULL CHECK (event_type IN ('placement', 'replacement', 'cancellation')),
        operation_fee_stroops TEXT NOT NULL,
        estimated_fee_xlm TEXT NOT NULL,
        quote_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        xlm_to_quote_rate TEXT,
        estimated_fee_quote TEXT,
        conversion_snapshot_id INTEGER REFERENCES market_snapshots(id),
        nature TEXT NOT NULL CHECK (nature = 'simulated_estimate'),
        actual_fee_xlm TEXT CHECK (actual_fee_xlm IS NULL),
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE paper_lots (
        lot_id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        source_fill_id TEXT UNIQUE REFERENCES paper_fills(fill_id),
        base_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        quote_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        original_base TEXT NOT NULL,
        remaining_base TEXT NOT NULL,
        unit_cost_quote TEXT,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX paper_lots_fifo
        ON paper_lots(portfolio_id, base_asset_id, created_at_ms);

      CREATE TABLE paper_realized_pnl (
        fill_id TEXT PRIMARY KEY REFERENCES paper_fills(fill_id),
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        quote_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        sold_base TEXT NOT NULL,
        gross_pnl_quote TEXT,
        created_at_ms INTEGER NOT NULL
      );
    `);

    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(PAPER_TRADING_SCHEMA_VERSION, new Date().toISOString());
  })();

  database.transaction(() => {
    const hasPaperDepthMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(PAPER_DEPTH_SCHEMA_VERSION);
    if (hasPaperDepthMigration !== undefined) {
      return;
    }

    database.exec(`
      CREATE TABLE paper_depth_allocations (
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        level_index INTEGER NOT NULL CHECK (level_index >= 0),
        order_id TEXT NOT NULL REFERENCES paper_orders(order_id),
        base_amount TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, pair_id, side, level_index, order_id)
      );
      CREATE INDEX paper_depth_allocations_snapshot
        ON paper_depth_allocations(snapshot_id, pair_id, side, level_index);
    `);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(PAPER_DEPTH_SCHEMA_VERSION, new Date().toISOString());
  })();

  database.transaction(() => {
    const hasObservationMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(MARKET_OBSERVATION_SCHEMA_VERSION);
    if (hasObservationMigration !== undefined) {
      return;
    }

    database.exec(`
      ALTER TABLE market_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'horizon_orderbook';
      ALTER TABLE market_snapshots ADD COLUMN received_sequence INTEGER;
      ALTER TABLE market_snapshots ADD COLUMN source_timestamp_ms INTEGER;

      ALTER TABLE market_trades ADD COLUMN source TEXT NOT NULL DEFAULT 'horizon_sse';
      ALTER TABLE market_trades ADD COLUMN received_at_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE market_trades ADD COLUMN received_sequence INTEGER;
      ALTER TABLE market_trades ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (validation_status IN ('valid', 'rejected', 'quarantined', 'unverified'));
      ALTER TABLE market_trades ADD COLUMN validation_reasons_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE market_trades ADD COLUMN raw_json TEXT;

      ALTER TABLE strategy_decisions ADD COLUMN strategy_id TEXT NOT NULL DEFAULT 'passive_maker';
      ALTER TABLE strategy_decisions ADD COLUMN model_version TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE strategy_decisions ADD COLUMN observed_at_ms INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE market_stream_sessions (
        session_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        source TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        status TEXT NOT NULL CHECK (
          status IN ('connecting', 'streaming', 'degraded', 'backfilling', 'closed', 'failed')
        ),
        start_cursor TEXT,
        committed_cursor TEXT,
        error TEXT
      );
      CREATE INDEX market_stream_sessions_pair_time
        ON market_stream_sessions(pair_id, started_at_ms DESC);

      CREATE TABLE market_data_gaps (
        gap_id TEXT PRIMARY KEY,
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        session_id TEXT REFERENCES market_stream_sessions(session_id),
        source TEXT NOT NULL,
        detected_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        from_cursor TEXT,
        to_cursor TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('open', 'backfilling', 'resolved', 'unrecoverable')
        ),
        reason TEXT NOT NULL,
        recovered_event_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX market_data_gaps_pair_status
        ON market_data_gaps(pair_id, status, detected_at_ms);

      CREATE TABLE hypothetical_orders (
        hypothetical_order_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE REFERENCES strategy_decisions(decision_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        strategy_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        limit_price TEXT NOT NULL,
        requested_base TEXT NOT NULL,
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        start_cursor TEXT,
        observed_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        displayed_queue_ahead_base TEXT NOT NULL,
        queue_lower_bound_base TEXT NOT NULL,
        queue_upper_bound_base TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('observing', 'complete', 'incomplete', 'rejected')
        ),
        quality_reasons_json TEXT NOT NULL
      );
      CREATE INDEX hypothetical_orders_pair_time
        ON hypothetical_orders(pair_id, observed_at_ms DESC);
      CREATE INDEX hypothetical_orders_expiry
        ON hypothetical_orders(pair_id, status, expires_at_ms);

      CREATE TABLE execution_evidence (
        hypothetical_order_id TEXT PRIMARY KEY
          REFERENCES hypothetical_orders(hypothetical_order_id),
        exact_price_volume_base TEXT NOT NULL DEFAULT '0',
        through_price_volume_base TEXT NOT NULL DEFAULT '0',
        estimated_fill_lower_base TEXT NOT NULL DEFAULT '0',
        estimated_fill_upper_base TEXT NOT NULL DEFAULT '0',
        estimated_fill_probability_lower TEXT,
        estimated_fill_probability_upper TEXT,
        partial_fill_probability_lower TEXT,
        partial_fill_probability_upper TEXT,
        observed_trade_count INTEGER NOT NULL DEFAULT 0,
        quality_status TEXT NOT NULL CHECK (
          quality_status IN ('complete', 'incomplete', 'unvalidated')
        ),
        quality_reasons_json TEXT NOT NULL,
        model_version TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE hypothetical_trade_evidence (
        hypothetical_order_id TEXT NOT NULL
          REFERENCES hypothetical_orders(hypothetical_order_id),
        trade_id TEXT NOT NULL REFERENCES market_trades(trade_id),
        observed_at_ms INTEGER NOT NULL,
        trade_price TEXT NOT NULL,
        exact_price_volume_base TEXT NOT NULL,
        through_price_volume_base TEXT NOT NULL,
        estimated_fill_lower_base TEXT NOT NULL,
        estimated_fill_upper_base TEXT NOT NULL,
        attribution TEXT NOT NULL CHECK (
          attribution IN ('exact_price_observed', 'through_price_observed')
        ),
        PRIMARY KEY (hypothetical_order_id, trade_id)
      );
      CREATE INDEX hypothetical_trade_evidence_order_time
        ON hypothetical_trade_evidence(hypothetical_order_id, observed_at_ms);

      CREATE TABLE markout_observations (
        markout_id TEXT PRIMARY KEY,
        hypothetical_order_id TEXT NOT NULL
          REFERENCES hypothetical_orders(hypothetical_order_id),
        estimated_fill_trade_id TEXT NOT NULL REFERENCES market_trades(trade_id),
        horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes IN (1, 5, 15, 60)),
        target_at_ms INTEGER NOT NULL,
        selected_snapshot_id INTEGER REFERENCES market_snapshots(id),
        estimated_fill_base TEXT NOT NULL,
        liquidation_quote TEXT,
        markout_gross_quote TEXT,
        estimated_exit_fee_quote TEXT,
        markout_net_quote TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'complete', 'incomplete', 'invalid')
        ),
        quality_reasons_json TEXT NOT NULL,
        calculated_at_ms INTEGER NOT NULL,
        UNIQUE (hypothetical_order_id, estimated_fill_trade_id, horizon_minutes)
      );
      CREATE INDEX markout_observations_target
        ON markout_observations(status, target_at_ms);

      CREATE TABLE portfolio_valuation_snapshots (
        valuation_id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES paper_portfolios(portfolio_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        quote_asset_id TEXT NOT NULL REFERENCES assets(asset_id),
        snapshot_id INTEGER REFERENCES market_snapshots(id),
        observed_at_ms INTEGER NOT NULL,
        quote_cash TEXT NOT NULL,
        inventory_base TEXT NOT NULL,
        inventory_liquidation_quote TEXT,
        inventory_cost_basis_quote TEXT,
        realized_net_pnl_today_quote TEXT,
        unrealized_net_pnl_quote TEXT,
        daily_net_pnl_quote TEXT,
        inventory_exposure_quote TEXT,
        maximum_drawdown_quote TEXT,
        valuation_status TEXT NOT NULL CHECK (
          valuation_status IN ('complete', 'incomplete', 'invalid')
        ),
        quality_reasons_json TEXT NOT NULL
      );
      CREATE INDEX portfolio_valuation_pair_time
        ON portfolio_valuation_snapshots(portfolio_id, pair_id, observed_at_ms);
    `);

    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(MARKET_OBSERVATION_SCHEMA_VERSION, new Date().toISOString());
  })();

  database.transaction(() => {
    const hasReplayMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(HISTORICAL_REPLAY_SCHEMA_VERSION);
    if (hasReplayMigration !== undefined) {
      return;
    }

    database.exec(`
      CREATE TABLE historical_replay_runs (
        replay_run_id TEXT PRIMARY KEY,
        input_fingerprint TEXT NOT NULL,
        model_version TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('independent_counterfactual')),
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
        scenario_count INTEGER NOT NULL DEFAULT 0,
        quality_summary_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (input_fingerprint, model_version, execution_mode)
      );

      CREATE TABLE research_execution_scenarios (
        scenario_id TEXT PRIMARY KEY,
        replay_run_id TEXT NOT NULL REFERENCES historical_replay_runs(replay_run_id),
        source_decision_id TEXT NOT NULL REFERENCES strategy_decisions(decision_id),
        source_hypothetical_order_id TEXT NOT NULL
          REFERENCES hypothetical_orders(hypothetical_order_id),
        pair_id TEXT NOT NULL REFERENCES trading_pairs(pair_id),
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        limit_price TEXT NOT NULL,
        requested_base TEXT NOT NULL,
        placement_at_ms INTEGER NOT NULL,
        placement_snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        initial_visible_queue_base TEXT NOT NULL,
        starting_trade_cursor TEXT,
        expires_at_ms INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        execution_mode TEXT NOT NULL CHECK (execution_mode = 'independent_counterfactual'),
        status TEXT NOT NULL CHECK (
          status IN ('modeled_fill', 'partial_fill', 'no_fill_evidence', 'uncertain', 'incomplete')
        ),
        estimated_fill_lower_base TEXT NOT NULL,
        estimated_fill_upper_base TEXT NOT NULL,
        remaining_lower_base TEXT NOT NULL,
        remaining_upper_base TEXT NOT NULL,
        first_fill_at_ms INTEGER,
        evidence_quality TEXT NOT NULL CHECK (
          evidence_quality IN ('sufficient', 'uncertain', 'incomplete')
        ),
        confidence TEXT NOT NULL CHECK (
          confidence IN ('high', 'medium', 'low', 'none')
        ),
        quality_reasons_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE (replay_run_id, source_decision_id)
      );
      CREATE INDEX research_execution_scenarios_run_pair
        ON research_execution_scenarios(replay_run_id, pair_id, placement_at_ms);

      CREATE TABLE research_execution_events (
        scenario_id TEXT NOT NULL REFERENCES research_execution_scenarios(scenario_id),
        trade_id TEXT NOT NULL REFERENCES market_trades(trade_id),
        event_at_ms INTEGER NOT NULL,
        trade_price TEXT NOT NULL,
        public_trade_volume_base TEXT NOT NULL,
        queue_ahead_lower_before_base TEXT NOT NULL,
        queue_ahead_upper_before_base TEXT NOT NULL,
        modeled_fill_lower_base TEXT NOT NULL,
        modeled_fill_upper_base TEXT NOT NULL,
        fill_classification TEXT NOT NULL CHECK (
          fill_classification IN (
            'confirmed_public_trade_evidence',
            'modeled_fill_estimate',
            'uncertain_fill',
            'no_fill_evidence'
          )
        ),
        quality_reasons_json TEXT NOT NULL,
        PRIMARY KEY (scenario_id, trade_id)
      );
      CREATE INDEX research_execution_events_scenario_time
        ON research_execution_events(scenario_id, event_at_ms);

      CREATE TABLE research_markout_observations (
        scenario_id TEXT NOT NULL REFERENCES research_execution_scenarios(scenario_id),
        fill_trade_id TEXT NOT NULL REFERENCES market_trades(trade_id),
        horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds IN (5, 30, 60, 300, 900)),
        target_at_ms INTEGER NOT NULL,
        sampled_snapshot_id INTEGER REFERENCES market_snapshots(id),
        sampled_at_ms INTEGER,
        sampling_deviation_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('complete', 'pending', 'incomplete', 'invalid')),
        fill_base TEXT NOT NULL,
        fill_price TEXT NOT NULL,
        spread_capture_quote TEXT,
        post_fill_price_movement_quote TEXT,
        liquidation_impact_quote TEXT,
        estimated_fees_quote TEXT,
        net_markout_quote TEXT,
        quality_reasons_json TEXT NOT NULL,
        PRIMARY KEY (scenario_id, fill_trade_id, horizon_seconds)
      );
      CREATE INDEX research_markout_horizon_status
        ON research_markout_observations(horizon_seconds, status, target_at_ms);
    `);

    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(HISTORICAL_REPLAY_SCHEMA_VERSION, new Date().toISOString());
  })();

  database.transaction(() => {
    const hasReplayDetailsMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(HISTORICAL_REPLAY_DETAILS_SCHEMA_VERSION);
    if (hasReplayDetailsMigration !== undefined) {
      return;
    }

    const scenarioColumns = database
      .prepare("PRAGMA table_info(research_execution_scenarios)")
      .all() as Array<{ name: string }>;
    if (!scenarioColumns.some((column) => column.name === "initial_queue_lower_base")) {
      database.exec(`
        ALTER TABLE research_execution_scenarios
          ADD COLUMN initial_queue_lower_base TEXT NOT NULL DEFAULT '0';
      `);
    }
    if (!scenarioColumns.some((column) => column.name === "initial_queue_upper_base")) {
      database.exec(`
        ALTER TABLE research_execution_scenarios
          ADD COLUMN initial_queue_upper_base TEXT NOT NULL DEFAULT '0';
      `);
    }
    const eventColumns = database
      .prepare("PRAGMA table_info(research_execution_events)")
      .all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === "modeled_fill_price")) {
      database.exec(`
        ALTER TABLE research_execution_events ADD COLUMN modeled_fill_price TEXT;
      `);
    }
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(HISTORICAL_REPLAY_DETAILS_SCHEMA_VERSION, new Date().toISOString());
  })();

  database.transaction(() => {
    const hasHorizonMetadataMigration = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(HORIZON_METADATA_AND_MARKOUT_REFERENCE_SCHEMA_VERSION);
    if (hasHorizonMetadataMigration !== undefined) {
      return;
    }

    database.exec(`
      ALTER TABLE market_trades ADD COLUMN ledger_close_time TEXT;
      ALTER TABLE market_trades ADD COLUMN base_offer_id TEXT;
      ALTER TABLE market_trades ADD COLUMN counter_offer_id TEXT;
      ALTER TABLE market_trades ADD COLUMN base_account TEXT;
      ALTER TABLE market_trades ADD COLUMN counter_account TEXT;
      ALTER TABLE market_trades ADD COLUMN base_liquidity_pool_id TEXT;
      ALTER TABLE market_trades ADD COLUMN counter_liquidity_pool_id TEXT;
      ALTER TABLE market_trades ADD COLUMN operation_id TEXT;
      ALTER TABLE market_trades ADD COLUMN transaction_hash TEXT;
      ALTER TABLE market_trades ADD COLUMN horizon_raw_json TEXT;

      ALTER TABLE research_markout_observations
        ADD COLUMN fill_reference_snapshot_id INTEGER REFERENCES market_snapshots(id);
      ALTER TABLE research_markout_observations ADD COLUMN fill_reference_at_ms INTEGER;
      ALTER TABLE research_markout_observations ADD COLUMN fill_reference_deviation_ms INTEGER;
      ALTER TABLE research_markout_observations ADD COLUMN fill_reference_time_basis TEXT;
    `);

    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(HORIZON_METADATA_AND_MARKOUT_REFERENCE_SCHEMA_VERSION, new Date().toISOString());
  })();

  return database;
}
