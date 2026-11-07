import { loadConfig } from "./config/schema.js";
import { createLogger } from "./common/logger.js";
import { HorizonFeeDataSource, NetworkFeeEstimator } from "./market-data/fee-estimator.js";
import { isOrderBookFresh, MarketDataService } from "./market-data/market-data-service.js";
import {
  getXlmQuoteReferencePair,
  invalidateFeeConversion,
  isAssetVerified,
  validateFeeConversion,
  validateOrderBookIntegrity,
} from "./market-data/market-integrity.js";
import { HorizonOrderBookSource } from "./market-data/order-book-source.js";
import { HorizonTradeSource } from "./market-data/trade-source.js";
import { evaluatePassiveMakerSignal, type PassiveMakerSignal } from "./strategies/passive-maker.js";
import type { OrderBookSnapshot } from "./order-book/types.js";
import { getPairId } from "./order-book/normalize.js";
import { HorizonClient } from "./stellar/horizon-client.js";
import {
  AssetIdentityValidator,
  HorizonAssetIdentitySource,
} from "./stellar/asset-identity.js";
import { getMakerPortfolioState, initializePaperPortfolio } from "./paper-trading/portfolio.js";
import { buildPaperTradingReport } from "./reporting/paper-report.js";
import { buildObservationReport } from "./reporting/observation-report.js";
import { openDatabase } from "./storage/database.js";
import {
  getAssetId,
  recordMarketSnapshot,
  recordStrategyDecision,
} from "./storage/market-store.js";
import {
  backfillObservedTrades,
  completeExpiredHypotheticalOrders,
  openTradeStreamSession,
  recordHypotheticalOrder,
  recordObservedTrade,
  recordPortfolioValuation,
  recordTradeStreamGap,
  updateMaturedMarkouts,
} from "./observation/market-observation.js";

async function main(): Promise<void> {
  let database: ReturnType<typeof openDatabase> | undefined;
  let logger = createLogger("info");
  let marketData: MarketDataService | undefined;
  let freshnessTimer: NodeJS.Timeout | undefined;
  let reportTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  const tradeStreamStops = new Map<string, () => void>();
  const reconnectTimers = new Map<string, NodeJS.Timeout>();
  const tradeFlowHealthy = new Set<string>();

  try {
    const config = loadConfig();
    logger = createLogger(config.logLevel);
    database = openDatabase(config.databasePath);

    const status = await new HorizonClient(config).checkConnection();
    logger.info(status, "Connected to Stellar Horizon");

    if (config.pairs.length === 0) {
      logger.info("No trading pairs configured; set STELLAR_PAIRS to start order book streams");
      database.close();
      return;
    }

    const identityValidator = new AssetIdentityValidator(
      database,
      config,
      new HorizonAssetIdentitySource(config.horizonUrl),
    );
    for (const pair of config.pairs) {
      const results = await identityValidator.validatePair(pair);
      for (const result of results) {
        logger.info(result, "Configured Stellar asset identity validation");
      }
    }

    initializePaperPortfolio({
      database,
      portfolioId: config.paperPortfolioId,
      initialBalances: {},
    });

    const marketDataService = new MarketDataService(new HorizonOrderBookSource(config));
    marketData = marketDataService;
    const feeEstimator = new NetworkFeeEstimator(
      new HorizonFeeDataSource(config),
      config,
    );
    const tradeSource = new HorizonTradeSource(config);
    const latestBooks = new Map<string, OrderBookSnapshot>();
    const latestSnapshotIds = new Map<string, number>();
    const latestSignals = new Map<string, PassiveMakerSignal[]>();
    const stalePairs = new Set<string>();
    const evaluationPending = new Set<string>();
    const evaluationRunning = new Set<string>();

    const evaluatePair = async (pair: (typeof config.pairs)[number]): Promise<void> => {
      const pairId = getPairId(pair);
      const book = latestBooks.get(pairId);
      const snapshotId = latestSnapshotIds.get(pairId);
      if (!book || snapshotId === undefined) {
        return;
      }

      const estimate = await feeEstimator.estimateRoundTrip(
        pair.quote,
        config.makerReplacementsPerOrder,
      );
      const quoteAssetId = getAssetId(pair.quote);
      const referencePair = getXlmQuoteReferencePair(config.pairs, quoteAssetId);
      const referenceBook = referencePair
        ? latestBooks.get(getPairId(referencePair))
        : undefined;
      let fees = estimate;
      if (quoteAssetId !== "native") {
        const reason = validateFeeConversion({
          estimate,
          quoteAssetId,
          referenceBook,
          probeXlm: config.feeConversionProbeXlm,
          maxBookAgeMs: config.maxOrderBookAgeMs,
          maxDeviationBps: config.feeConversionMaxDeviationBps,
        });
        if (reason !== null) {
          fees = invalidateFeeConversion(estimate, reason);
        }
      }
      if (!fees.complete) {
        logger.warn(
          {
            pairId,
            reason: fees.reason,
            error: fees.error,
            networkFeeXlm: fees.networkFeeXlm,
          },
          "Network fee conversion is incomplete; net profitability cannot be established",
        );
      }

      const portfolio = getMakerPortfolioState(
        database!,
        config.paperPortfolioId,
        pair,
      );
      const identityValid = [pair.base, pair.quote].every((asset) =>
        isAssetVerified(
          database!,
          getAssetId(asset),
          Date.now(),
          config.assetValidationMaxAgeMs,
        ),
      );
      const results: PassiveMakerSignal[] = [];
      for (const side of ["buy", "sell"] as const) {
        const signal = evaluatePassiveMakerSignal({
          book,
          pair,
          side,
          portfolio,
          evidence: undefined,
          fees,
          assetIdentityValid: identityValid,
          orderFlowAvailable: tradeFlowHealthy.has(pairId),
          config,
        });
        results.push(signal);
        const decisionId = recordStrategyDecision({
          database: database!,
          pairId,
          snapshotId,
          side,
          status: signal.status,
          reasons: signal.reasons,
          evidence: undefined,
          feeEstimate: fees,
          createdAtMs: Date.now(),
          strategyId: "passive_maker",
          modelVersion: "passive_maker_v1",
        });
        const savedCursor = database!.prepare(`
          SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
        `).get(pairId) as { trade_cursor: string } | undefined;
        recordHypotheticalOrder({
          database: database!,
          decisionId,
          snapshotId,
          book,
          signal,
          cursor: savedCursor?.trade_cursor ?? null,
        });
        logger.info({ signal }, "Passive maker signal evaluation");
      }
      latestSignals.set(pairId, results);
    };

    const scheduleEvaluation = (pair: (typeof config.pairs)[number]): void => {
      const pairId = getPairId(pair);
      evaluationPending.add(pairId);
      if (evaluationRunning.has(pairId)) {
        return;
      }
      evaluationRunning.add(pairId);
      void (async () => {
        while (evaluationPending.delete(pairId)) {
          try {
            await evaluatePair(pair);
          } catch (error) {
            logger.error({ err: error, pairId }, "Passive maker signal evaluation failed");
          }
        }
      })().finally(() => {
        evaluationRunning.delete(pairId);
        if (evaluationPending.has(pairId)) {
          scheduleEvaluation(pair);
        }
      });
    };

    const emitReport = (): void => {
      const report = buildPaperTradingReport({
        database: database!,
        portfolioId: config.paperPortfolioId,
        books: latestBooks,
        signals: latestSignals,
        maxOrderBookAgeMs: config.maxOrderBookAgeMs,
      });
      logger.info({ report }, "Observation-mode portfolio and signal report");
      const observationReport = buildObservationReport({
        database: database!,
        portfolioId: config.paperPortfolioId,
      });
      logger.info({ report: observationReport }, "Market observation and execution evidence report");
    };

    for (const pair of config.pairs) {
      await marketDataService.start(pair, {
        onUpdate: (book) => {
          latestBooks.set(book.pairId, book);
          const reasons = validateOrderBookIntegrity(
            book,
            config.maxOrderBookAgeMs,
          );
          const snapshotId = recordMarketSnapshot(database!, book, reasons);
          latestSnapshotIds.set(book.pairId, snapshotId);
          const markoutsUpdated = updateMaturedMarkouts({
            database: database!,
            book,
            snapshotId,
            maxOrderBookAgeMs: config.maxOrderBookAgeMs,
          });
          const observationsClosed = completeExpiredHypotheticalOrders({
            database: database!,
            pairId: book.pairId,
            observedAtMs: book.receivedAtMs,
          });
          const valuation = recordPortfolioValuation({
            database: database!,
            portfolioId: config.paperPortfolioId,
            pair,
            book,
            snapshotId,
            maxOrderBookAgeMs: config.maxOrderBookAgeMs,
          });
          if (valuation.status !== "complete") {
            logger.warn(
              { pairId: book.pairId, reasons: valuation.reasons },
              "Portfolio risk valuation is incomplete; loss-limit status is untrusted",
            );
          }
          if (stalePairs.delete(book.pairId)) {
            logger.info({ pairId: book.pairId }, "Order book data is fresh again");
          }
          logger.info(
            {
              pairId: book.pairId,
              bestBid: book.bestBid,
              bestAsk: book.bestAsk,
              spreadAbsolute: book.spreadAbsolute,
              spreadPercent: book.spreadPercent,
              bidDepth: book.bidDepth,
              askDepth: book.askDepth,
              receivedAt: book.receivedAt,
              validationReasons: reasons,
              markoutsUpdated,
              observationsClosed,
            },
            "Received Stellar DEX order book",
          );
          for (const configuredPair of config.pairs) {
            if (latestBooks.has(getPairId(configuredPair))) {
              scheduleEvaluation(configuredPair);
            }
          }
        },
        onError: (error) => {
          logger.error({ err: error, pair }, "Order book stream reported an error");
        },
      });
    }

    const startTradeStream = async (
      pair: (typeof config.pairs)[number],
    ): Promise<void> => {
      const pairId = getPairId(pair);
      if (stopping) {
        return;
      }
      const saved = database!.prepare(`
        SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
      `).get(pairId) as { trade_cursor: string } | undefined;
      let cursor = saved?.trade_cursor ?? null;
      const sessionId = openTradeStreamSession({
        database: database!,
        pairId,
        source: "horizon_sse",
        cursor,
      });
      let recoveredCount = 0;
      try {
        cursor ??= await tradeSource.latestCursor(pair);
        database!.prepare(`
          UPDATE market_stream_sessions SET start_cursor = ? WHERE session_id = ?
        `).run(cursor, sessionId);
        if (saved) {
          const caughtUp = await backfillObservedTrades({
            database: database!,
            source: tradeSource,
            pair,
            pairId,
            sessionId,
            cursor,
            onValidationIssue: (trade, reasons) => {
              tradeFlowHealthy.delete(pairId);
              logger.warn(
                { pairId, tradeId: trade.tradeId, reasons },
                "Quarantined a malformed or incorrectly timestamped backfill trade",
              );
            },
          });
          recoveredCount = caughtUp.count;
        }
        const nextCursor = (database!.prepare(`
          SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
        `).get(pairId) as { trade_cursor: string } | undefined)?.trade_cursor ?? cursor;
        let recoveryStarted = false;
        let stopStream: (() => void) | undefined;
        const recoverStream = (error: unknown): void => {
          tradeFlowHealthy.delete(pairId);
          logger.error({ err: error, pairId }, "Horizon trade stream failed; recording a data gap");
          if (recoveryStarted || stopping) {
            return;
          }
          recoveryStarted = true;
          const savedCursor = (database!.prepare(`
            SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
          `).get(pairId) as { trade_cursor: string } | undefined)?.trade_cursor ?? null;
          recordTradeStreamGap({
            database: database!,
            pairId,
            sessionId,
            source: "horizon_sse",
            fromCursor: savedCursor,
            reason: error instanceof Error ? error.message : "horizon_stream_error",
          });
          stopStream?.();
          tradeStreamStops.delete(pairId);
          const timer = setTimeout(() => {
            reconnectTimers.delete(pairId);
            void startTradeStream(pair).catch((retryError: unknown) => {
              logger.error({ err: retryError, pairId }, "Horizon trade stream recovery failed");
            });
          }, config.retryBaseDelayMs);
          reconnectTimers.set(pairId, timer);
        };
        const stop = tradeSource.stream(pair, nextCursor, {
          onTrade: (trade) => {
            try {
              const result = recordObservedTrade({ database: database!, trade });
              database!.prepare(`
                UPDATE market_stream_sessions
                SET committed_cursor = ?, status = 'streaming'
                WHERE session_id = ?
              `).run(trade.cursor, sessionId);
              if (result.validationReasons.length > 0) {
                tradeFlowHealthy.delete(pairId);
                logger.warn(
                  { pairId, tradeId: trade.tradeId, reasons: result.validationReasons },
                  "Quarantined a malformed or incorrectly timestamped Horizon trade",
                );
              }
            } catch (error) {
              logger.error({ err: error, pairId, tradeId: trade.tradeId }, "Could not persist observed trade");
              recoverStream(error);
            }
          },
          onError: recoverStream,
        });
        stopStream = stop;
        tradeStreamStops.set(pairId, stop);
        tradeFlowHealthy.add(pairId);
        database!.prepare(`
          UPDATE market_stream_sessions
          SET status = 'streaming', committed_cursor = ?
          WHERE session_id = ?
        `).run(nextCursor, sessionId);
        logger.info(
          { pairId, sessionId, cursor: nextCursor, recoveredCount },
          "Started observation-only Horizon trade stream",
        );
      } catch (error) {
        tradeFlowHealthy.delete(pairId);
        const gapId = recordTradeStreamGap({
          database: database!,
          pairId,
          sessionId,
          source: "horizon_sse",
          fromCursor: cursor,
          reason: error instanceof Error ? error.message : "horizon_backfill_failed",
        });
        logger.error({ err: error, pairId, gapId }, "Horizon trade backfill failed; retrying");
        const timer = setTimeout(() => {
          reconnectTimers.delete(pairId);
          void startTradeStream(pair).catch((retryError: unknown) => {
            logger.error({ err: retryError, pairId }, "Horizon trade recovery retry failed");
          });
        }, config.retryBaseDelayMs);
        reconnectTimers.set(pairId, timer);
      }
    };

    for (const pair of config.pairs) {
      void startTradeStream(pair).catch((error: unknown) => {
        logger.error({ err: error, pairId: getPairId(pair) }, "Could not start observation trade stream");
      });
      scheduleEvaluation(pair);
    }

    freshnessTimer = setInterval(() => {
      for (const [pairId, book] of latestBooks) {
        if (!isOrderBookFresh(book, config.maxOrderBookAgeMs) && !stalePairs.has(pairId)) {
          stalePairs.add(pairId);
          logger.warn(
            { pairId, receivedAt: book.receivedAt, maxAgeMs: config.maxOrderBookAgeMs },
            "Order book data is stale",
          );
        }
      }
    }, Math.min(config.maxOrderBookAgeMs, 1000));
    freshnessTimer.unref();
    reportTimer = setInterval(emitReport, 30_000);
    reportTimer.unref();
    emitReport();

    const shutdown = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      if (freshnessTimer) {
        clearInterval(freshnessTimer);
      }
      if (reportTimer) {
        clearInterval(reportTimer);
      }
      for (const stop of tradeStreamStops.values()) {
        stop();
      }
      for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
      }
      database?.prepare(`
        UPDATE market_stream_sessions
        SET status = 'closed', ended_at_ms = ?
        WHERE status IN ('connecting', 'streaming', 'backfilling')
      `).run(Date.now());
      marketData?.stopAll();
      database?.close();
      logger.info("Stopped Stellar market data and trade streams");
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    for (const stop of tradeStreamStops.values()) {
      stop();
    }
    marketData?.stopAll();
    if (freshnessTimer) {
      clearInterval(freshnessTimer);
    }
    if (reportTimer) {
      clearInterval(reportTimer);
    }
    database?.prepare(`
      UPDATE market_stream_sessions
      SET status = 'closed', ended_at_ms = ?
      WHERE status IN ('connecting', 'streaming', 'backfilling')
    `).run(Date.now());
    database?.close();
    logger.fatal({ err: error }, "Stellar scanner startup failed");
    process.exitCode = 1;
  }
}

void main();
