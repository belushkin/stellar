import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { Big } from "../common/decimal.js";
import type { AppConfig, TradingPairConfig } from "../config/schema.js";
import { estimateExecutableVolume } from "../order-book/executable-volume.js";
import { validateOrderBookIntegrity, validateXlmConversionRoute } from "../market-data/market-integrity.js";
import type { HorizonTradePrint } from "../market-data/trade-source.js";
import type { OrderBookSnapshot } from "../order-book/types.js";
import { getPairId } from "../order-book/normalize.js";
import { getAssetId } from "../storage/market-store.js";
import { isAssetVerified } from "../market-data/market-integrity.js";
import { applyBalanceDelta, getPaperBalance } from "./portfolio.js";

export interface PaperFeeContext {
  operationFeeStroops: string;
  quoteAssetId: string;
  quotePerXlm: string;
  conversionPath: string[];
  conversionSnapshotId: number | null;
  referenceBook: OrderBookSnapshot | undefined;
}

export interface PaperOrderReceipt {
  orderId: string;
  status: "open" | "partially_filled" | "filled" | "cancelled" | "rejected" | "paused";
  duplicate: boolean;
  reason: string | null;
}

interface PaperOrderRow {
  order_id: string;
  client_order_key: string;
  portfolio_id: string;
  pair_id: string;
  decision_id: string | null;
  order_type: "limit" | "marketable_limit";
  side: "buy" | "sell";
  limit_price: string;
  requested_base: string;
  filled_base: string;
  remaining_base: string;
  queue_ahead_base: string;
  queue_consumed_base: string;
  fee_operation_stroops: string;
  fee_quote_per_xlm: string | null;
  fee_conversion_snapshot_id: number | null;
  reserved_fee_xlm: string;
  fee_operations_remaining: number;
  max_replacements: number;
  status: PaperOrderReceipt["status"];
  placement_snapshot_id: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PairAssets {
  base_asset_id: string;
  quote_asset_id: string;
}

interface SnapshotRow {
  pair_id: string;
  integrity_status: "valid" | "rejected";
  received_at_ms: number;
  content_hash: string;
}

export class PaperTradingEngine {
  constructor(
    private readonly database: Database.Database,
    private readonly config: Pick<
      AppConfig,
      | "maxOrderBookAgeMs"
      | "maximumMakerOrderBase"
      | "maximumInventoryBase"
      | "makerReplacementsPerOrder"
      | "feeConversionProbeXlm"
      | "feeConversionMaxDeviationBps"
      | "assetValidationMaxAgeMs"
      | "paperEmergencyStop"
      | "paperMaxDailyLossByQuote"
    >,
  ) {}

  submitOrder(input: {
    portfolioId: string;
    pair: TradingPairConfig;
    decisionId: string;
    clientOrderKey: string;
    orderType: "limit" | "marketable_limit";
    side: "buy" | "sell";
    limitPrice: string;
    baseAmount: string;
    book: OrderBookSnapshot;
    snapshotId: number;
    fees: PaperFeeContext;
    nowMs?: number;
  }): PaperOrderReceipt {
    const nowMs = input.nowMs ?? Date.now();
    const pairId = getPairId(input.pair);
    const orderId = randomUUID();
    const limitPrice = positiveDecimal(input.limitPrice, "Limit price");
    const baseAmount = positiveDecimal(input.baseAmount, "Order amount");
    const orderSizeLimit = new Big(this.config.maximumMakerOrderBase);
    if (baseAmount.gt(orderSizeLimit)) {
      throw new Error("Paper order exceeds the configured maximum maker order size");
    }
    if (input.clientOrderKey.trim().length === 0) {
      throw new Error("Paper order client key must not be empty");
    }

    return this.database.transaction(() => {
      if (!this.database.prepare(`
        SELECT 1 FROM paper_portfolios WHERE portfolio_id = ?
      `).get(input.portfolioId)) {
        throw new Error(`Unknown paper portfolio ${input.portfolioId}`);
      }
      const registeredPair = this.database.prepare(`
        SELECT base_asset_id, quote_asset_id
        FROM trading_pairs WHERE pair_id = ?
      `).get(pairId) as PairAssets | undefined;
      if (!registeredPair) {
        throw new Error(`Unknown trading pair ${pairId}`);
      }
      if (
        registeredPair.base_asset_id !== getAssetId(input.pair.base)
        || registeredPair.quote_asset_id !== getAssetId(input.pair.quote)
      ) {
        throw new Error("Configured trading pair assets do not match the registered pair");
      }
      const duplicate = this.database.prepare(`
        SELECT order_id, status FROM paper_orders WHERE client_order_key = ?
      `).get(input.clientOrderKey) as { order_id: string; status: PaperOrderReceipt["status"] } | undefined;
      if (duplicate) {
        return {
          orderId: duplicate.order_id,
          status: duplicate.status,
          duplicate: true,
          reason: null,
        };
      }

      const validationReason = this.validateOrder(input, pairId, nowMs);
      const decisionExists = this.database.prepare(`
        SELECT 1 FROM strategy_decisions WHERE decision_id = ?
      `).get(input.decisionId) !== undefined;
      const queueAhead = validationReason === null
        ? this.computeQueueAhead(input.book, input.side, limitPrice, pairId)
        : new Big(0);
      const feeStroops = positiveDecimal(input.fees.operationFeeStroops, "Operation fee");
      const feeXlm = feeStroops.div(10_000_000);
      const maxReplacements = this.config.makerReplacementsPerOrder;
      const futureFeeReserve = feeXlm.times(maxReplacements + 1);
      const totalFeeReserve = feeXlm.plus(futureFeeReserve);
      const orderReserve = input.side === "buy"
        ? baseAmount.times(limitPrice)
        : baseAmount;
      const reserveAssetId = input.side === "buy"
        ? getAssetId(input.pair.quote)
        : getAssetId(input.pair.base);
      const xlmAvailable = new Big(
        getPaperBalance(this.database, input.portfolioId, "native").available,
      );
      const orderAvailable = reserveAssetId === "native"
        ? xlmAvailable
        : new Big(getPaperBalance(this.database, input.portfolioId, reserveAssetId).available);
      const xlmRequired = reserveAssetId === "native"
        ? orderReserve.plus(totalFeeReserve)
        : totalFeeReserve;
      const insufficientFunds = xlmAvailable.lt(xlmRequired)
        || (reserveAssetId !== "native" && orderAvailable.lt(orderReserve));
      const baseBalance = getPaperBalance(
        this.database,
        input.portfolioId,
        getAssetId(input.pair.base),
      );
      const currentInventory = new Big(baseBalance.available).plus(baseBalance.reserved);
      const outstandingBuyOrders = this.database.prepare(`
        SELECT remaining_base
        FROM paper_orders
        JOIN trading_pairs USING (pair_id)
        WHERE portfolio_id = ? AND base_asset_id = ? AND side = 'buy'
          AND status IN ('open', 'partially_filled')
      `).all(input.portfolioId, getAssetId(input.pair.base)) as { remaining_base: string }[];
      const pendingBuyExposure = outstandingBuyOrders.reduce(
        (total, order) => total.plus(order.remaining_base),
        new Big(0),
      );
      const maximumInventoryExceeded = input.side === "buy"
        && currentInventory.plus(pendingBuyExposure).plus(baseAmount)
          .gt(this.config.maximumInventoryBase);
      const reason = validationReason
        ?? (maximumInventoryExceeded ? "maximum_inventory_exceeded" : null)
        ?? (insufficientFunds ? "insufficient_virtual_balance" : null);
      const status: PaperOrderReceipt["status"] = reason === null ? "open" : "rejected";

      this.insertOrder({
        orderId,
        clientOrderKey: input.clientOrderKey,
        portfolioId: input.portfolioId,
        pairId,
        decisionId: decisionExists ? input.decisionId : null,
        orderType: input.orderType,
        side: input.side,
        limitPrice: limitPrice.toString(),
        baseAmount: baseAmount.toString(),
        queueAhead: queueAhead.toString(),
        operationFeeStroops: feeStroops.toString(),
        quotePerXlm: input.fees.quotePerXlm,
        futureFeeReserve: reason === null ? futureFeeReserve.toString() : "0",
        feeOperationsRemaining: reason === null ? maxReplacements + 1 : 0,
        feeConversionSnapshotId: input.fees.conversionSnapshotId,
        maxReplacements,
        status,
        snapshotId: input.snapshotId,
        nowMs,
      });

      if (reason !== null) {
        this.recordOrderEvent({
          orderId,
          eventType: "rejected",
          fromStatus: null,
          toStatus: "rejected",
          snapshotId: input.snapshotId,
          tradeId: null,
          payload: { reason },
          nowMs,
        });
        return { orderId, status, duplicate: false, reason };
      }

      this.reserveOrderAndFees({
        orderId,
        portfolioId: input.portfolioId,
        reserveAssetId,
        orderReserve,
        feeAssetId: "native",
        totalFeeReserve,
        futureFeeReserve,
        feeXlm,
        feeQuoteAssetId: getAssetId(input.pair.quote),
        feeQuotePerXlm: input.fees.quotePerXlm,
        feeConversionSnapshotId: input.fees.conversionSnapshotId,
        feeOperationStroops: feeStroops.toString(),
        nowMs,
      });

      this.recordOrderEvent({
        orderId,
        eventType: "placed",
        fromStatus: null,
        toStatus: "open",
        snapshotId: input.snapshotId,
        tradeId: null,
        payload: {
          limitPrice: limitPrice.toString(),
          requestedBase: baseAmount.toString(),
          queueAheadBase: queueAhead.toString(),
          orderType: input.orderType,
        },
        nowMs,
      });

      if (input.orderType === "marketable_limit") {
        this.fillFromDisplayedDepth({
          orderId,
          book: input.book,
          snapshotId: input.snapshotId,
          nowMs,
        });
      }
      return this.getOrderReceipt(orderId, false, null);
    }).immediate();
  }

  processTrade(input: {
    trade: HorizonTradePrint;
    book: OrderBookSnapshot;
    snapshotId: number;
    nowMs?: number;
  }): { duplicate: boolean; fillCount: number; pausedOrders: number } {
    const nowMs = input.nowMs ?? Date.now();
    const trade = input.trade;
    const amount = positiveDecimal(trade.baseAmount, "Trade base amount");
    const priceNumerator = positiveDecimal(trade.priceNumerator, "Trade price numerator");
    const priceDenominator = positiveDecimal(trade.priceDenominator, "Trade price denominator");
    const tradePrice = priceNumerator.div(priceDenominator);

    return this.database.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO market_trades (
          trade_id, pair_id, cursor, occurred_at_ms, base_amount, price_numerator,
          price_denominator, base_is_seller, trade_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trade.tradeId,
        trade.pairId,
        trade.cursor,
        trade.occurredAtMs,
        amount.toString(),
        priceNumerator.toString(),
        priceDenominator.toString(),
        trade.baseIsSeller ? 1 : 0,
        trade.tradeType,
      );
      this.advanceTradeCursor(trade.pairId, trade.cursor, nowMs);
      if (inserted.changes === 0) {
        return { duplicate: true, fillCount: 0, pausedOrders: 0 };
      }

      const integrityReasons = validateOrderBookIntegrity(
        input.book,
        this.config.maxOrderBookAgeMs,
        nowMs,
      );
      const snapshot = this.getSnapshot(input.snapshotId);
      if (
        trade.pairId !== input.book.pairId
        || input.book.pairId !== snapshot.pair_id
        || snapshot.integrity_status !== "valid"
        || snapshot.content_hash !== contentHash(input.book)
        || trade.occurredAtMs > nowMs
        || integrityReasons.length > 0
      ) {
        const reason = trade.pairId !== input.book.pairId
          ? "trade_book_pair_mismatch"
          : snapshot.pair_id !== input.book.pairId
            ? "trade_snapshot_pair_mismatch"
          : snapshot.integrity_status !== "valid" || snapshot.content_hash !== contentHash(input.book)
            ? "trade_snapshot_invalid_or_mismatched"
          : trade.occurredAtMs > nowMs
            ? "trade_timestamp_in_future"
          : integrityReasons[0] ?? "trade_order_book_integrity_failure";
        const pausedOrders = this.pauseOpenOrders(trade.pairId, input.snapshotId, trade.tradeId, reason, nowMs);
        return { duplicate: false, fillCount: 0, pausedOrders };
      }

      if (trade.tradeType !== "orderbook") {
        return { duplicate: false, fillCount: 0, pausedOrders: 0 };
      }
      if (!amount.gt(0) || !tradePrice.gt(0)) {
        throw new Error("Horizon trade amounts and price must be positive");
      }

      const orders = this.getOpenOrdersForTrade(trade.pairId, trade.baseIsSeller);
      const quoteAssetId = this.getPairAssets(trade.pairId).quote_asset_id;
      let tradeRemaining = amount;
      let volumeConsumedAhead = new Big(0);
      let fillCount = 0;
      for (const order of orders) {
        if (!new Big(order.remaining_base).gt(0)) {
          continue;
        }
        if (this.dailyLossLimitReached(
          order.portfolio_id,
          quoteAssetId,
          order.pair_id,
          input.book,
          nowMs,
        )) {
          const pausedOrders = this.pauseOpenOrders(
            trade.pairId,
            input.snapshotId,
            trade.tradeId,
            "maximum_daily_simulated_loss_reached",
            nowMs,
          );
          return { duplicate: false, fillCount, pausedOrders };
        }
        const orderLimit = new Big(order.limit_price);
        const priceEligible = order.side === "buy"
          ? tradePrice.lte(orderLimit)
          : tradePrice.gte(orderLimit);
        if (!priceEligible || trade.occurredAtMs <= order.created_at_ms) {
          continue;
        }
        const effectiveQueue = new Big(order.queue_ahead_base)
          .minus(volumeConsumedAhead);
        const queueAhead = effectiveQueue.gt(0) ? effectiveQueue : new Big(0);
        const queueTaken = tradeRemaining.lt(queueAhead) ? tradeRemaining : queueAhead;
        tradeRemaining = tradeRemaining.minus(queueTaken);
        volumeConsumedAhead = volumeConsumedAhead.plus(queueTaken);

        const volumeAfterQueue = tradeRemaining;
        const fill = volumeAfterQueue.lt(order.remaining_base)
          ? volumeAfterQueue
          : new Big(order.remaining_base);
        tradeRemaining = tradeRemaining.minus(fill);
        volumeConsumedAhead = volumeConsumedAhead.plus(fill);
        const queueConsumedTotal = queueTaken.plus(
          new Big(order.queue_ahead_base).minus(queueAhead),
        );
        this.database.prepare(`
          UPDATE paper_orders
          SET queue_ahead_base = ?, queue_consumed_base = ?, updated_at_ms = ?
          WHERE order_id = ?
        `).run(
          queueAhead.minus(queueTaken).toString(),
          new Big(order.queue_consumed_base).plus(queueConsumedTotal).toString(),
          nowMs,
          order.order_id,
        );
        this.database.prepare(`
          INSERT INTO paper_trade_allocations (
            trade_id, order_id, queue_consumed_base, filled_base
          ) VALUES (?, ?, ?, ?)
        `).run(trade.tradeId, order.order_id, queueConsumedTotal.toString(), fill.toString());

        if (fill.gt(0)) {
          this.applyFill({
            orderId: order.order_id,
            fillBase: fill,
            price: tradePrice,
            tradeId: trade.tradeId,
            snapshotId: input.snapshotId,
            sourceKind: "trade",
            idempotencyKey: `trade:${trade.tradeId}:order:${order.order_id}`,
            nowMs,
          });
          fillCount += 1;
          if (this.dailyLossLimitReached(
            order.portfolio_id,
            quoteAssetId,
            order.pair_id,
            input.book,
            nowMs,
          )) {
            const pausedOrders = this.pauseOpenOrders(
              trade.pairId,
              input.snapshotId,
              trade.tradeId,
              "maximum_daily_simulated_loss_reached",
              nowMs,
            );
            return { duplicate: false, fillCount, pausedOrders };
          }
        }
      }
      return { duplicate: false, fillCount, pausedOrders: 0 };
    }).immediate();
  }

  cancelOrder(orderId: string, snapshotId: number, nowMs = Date.now()): PaperOrderReceipt {
    return this.database.transaction(() => {
      const order = this.getOrder(orderId);
      if (order.status === "cancelled" || order.status === "filled" || order.status === "rejected") {
        return this.getOrderReceipt(orderId, false, null);
      }
      const snapshot = this.getSnapshot(snapshotId);
      if (snapshot.pair_id !== order.pair_id) {
        throw new Error("Cancellation snapshot pair does not match the order");
      }

      const feeRemaining = new Big(order.reserved_fee_xlm);
      const operationFee = new Big(order.fee_operation_stroops).div(10_000_000);
      if (order.fee_operations_remaining > 0 && feeRemaining.gte(operationFee)) {
        this.consumeFutureFee(order, "cancellation", nowMs);
      }

      const pair = this.getPairAssets(order.pair_id);
      const reserveAsset = order.side === "buy" ? pair.quote_asset_id : pair.base_asset_id;
      const orderReserve = order.side === "buy"
        ? new Big(order.remaining_base).times(order.limit_price)
        : new Big(order.remaining_base);
      if (orderReserve.gt(0)) {
        this.moveBalance({
          order,
          assetId: reserveAsset,
          from: "reserved",
          to: "available",
          amount: orderReserve,
          key: `order:${orderId}:cancel-release`,
          entryType: "order_reservation_released",
          nowMs,
        });
      }
      this.releaseFutureFees(this.getOrder(orderId), nowMs);
      this.database.prepare(`
        UPDATE paper_orders SET status = 'cancelled', updated_at_ms = ? WHERE order_id = ?
      `).run(nowMs, orderId);
      this.recordOrderEvent({
        orderId,
        eventType: "cancelled",
        fromStatus: order.status,
        toStatus: "cancelled",
        snapshotId,
        tradeId: null,
        payload: {},
        nowMs,
      });
      return this.getOrderReceipt(orderId, false, null);
    }).immediate();
  }

  pausePairOrders(
    pairId: string,
    snapshotId: number,
    reason: string,
    nowMs = Date.now(),
  ): number {
    return this.database.transaction(() => {
      const snapshot = this.getSnapshot(snapshotId);
      if (snapshot.pair_id !== pairId) {
        throw new Error("Pause snapshot pair does not match the requested pair");
      }
      return this.pauseOpenOrders(pairId, snapshotId, null, reason, nowMs);
    }).immediate();
  }

  private validateOrder(
    input: {
      portfolioId: string;
      pair: TradingPairConfig;
      decisionId: string;
      orderType: "limit" | "marketable_limit";
      side: "buy" | "sell";
      limitPrice: string;
      book: OrderBookSnapshot;
      snapshotId: number;
      fees: PaperFeeContext;
    },
    pairId: string,
    nowMs: number,
  ): string | null {
    if (this.config.paperEmergencyStop) {
      return "emergency_stop_active";
    }
    const decision = this.database.prepare(`
      SELECT pair_id, side, status, snapshot_id FROM strategy_decisions WHERE decision_id = ?
    `).get(input.decisionId) as {
      pair_id: string;
      side: string;
      status: string;
      snapshot_id: number;
    } | undefined;
    if (
      !decision
      || decision.status !== "positive"
      || decision.pair_id !== pairId
      || decision.side !== input.side
      || decision.snapshot_id !== input.snapshotId
    ) {
      return "strategy_decision_not_positive_or_mismatched";
    }
    const snapshot = this.getSnapshot(input.snapshotId);
    if (
      snapshot.pair_id !== pairId
      || snapshot.integrity_status !== "valid"
      || snapshot.content_hash !== contentHash(input.book)
    ) {
      return "market_snapshot_unavailable_or_mismatched";
    }
    const reasons = validateOrderBookIntegrity(
      input.book,
      this.config.maxOrderBookAgeMs,
      nowMs,
    );
    if (reasons.length > 0) {
      return reasons[0] ?? "order_book_integrity_failure";
    }
    if (input.book.pairId !== pairId) {
      return "order_book_pair_mismatch";
    }

    const baseAssetId = getAssetId(input.pair.base);
    const quoteAssetId = getAssetId(input.pair.quote);
    if (
      !isAssetVerified(this.database, baseAssetId, nowMs, this.config.assetValidationMaxAgeMs)
      || !isAssetVerified(this.database, quoteAssetId, nowMs, this.config.assetValidationMaxAgeMs)
    ) {
      return "asset_identity_unverified_or_stale";
    }
    const dailyPnl = this.getDailyRealizedNetPnl(
      input.portfolioId,
      quoteAssetId,
      pairId,
      input.book,
      nowMs,
    );
    const dailyLossLimit = this.config.paperMaxDailyLossByQuote[quoteAssetId];
    if (dailyPnl === null || !dailyLossLimit) {
      return "daily_loss_data_incomplete";
    }
    if (input.fees.quoteAssetId !== quoteAssetId) {
      return "fee_quote_asset_mismatch";
    }
    if (input.fees.quotePerXlm === undefined || !new Big(input.fees.quotePerXlm).gt(0)) {
      return "fee_conversion_rate_unavailable";
    }
    if (quoteAssetId === "native") {
      if (
        input.fees.quotePerXlm !== "1"
        || input.fees.conversionPath.join("/") !== "XLM"
      ) {
        return "native_fee_conversion_invalid";
      }
    } else {
      if (!input.fees.referenceBook) {
        return "fee_conversion_reference_book_unavailable";
      }
      const reason = validateXlmConversionRoute({
        quoteAssetId,
        quotePerXlm: input.fees.quotePerXlm,
        conversionPath: input.fees.conversionPath,
        referenceBook: input.fees.referenceBook,
        probeXlm: this.config.feeConversionProbeXlm,
        maxBookAgeMs: this.config.maxOrderBookAgeMs,
        maxDeviationBps: this.config.feeConversionMaxDeviationBps,
        nowMs,
      });
      if (reason !== null) {
        return reason;
      }
      if (input.fees.conversionSnapshotId === null) {
        return "fee_conversion_snapshot_unavailable";
      }
      const conversionSnapshot = this.getSnapshot(input.fees.conversionSnapshotId);
      if (
        conversionSnapshot.integrity_status !== "valid"
        || conversionSnapshot.content_hash !== contentHash(input.fees.referenceBook)
        || conversionSnapshot.pair_id !== `XLM/${quoteAssetId}`
      ) {
        return "fee_conversion_snapshot_mismatched";
      }
    }
    const projectedFeeQuote = new Big(input.fees.operationFeeStroops)
      .div(10_000_000)
      .times(this.config.makerReplacementsPerOrder + 2)
      .times(input.fees.quotePerXlm);
    if (
      dailyPnl.minus(projectedFeeQuote).lte(new Big(dailyLossLimit).neg())
    ) {
      return "maximum_daily_simulated_loss_reached";
    }

    const bestBid = input.book.bestBid;
    const bestAsk = input.book.bestAsk;
    if (bestBid === null || bestAsk === null) {
      return "two_sided_order_book_unavailable";
    }
    const marketable = input.side === "buy"
      ? new Big(input.limitPrice).gte(bestAsk)
      : new Big(input.limitPrice).lte(bestBid);
    if (input.orderType === "limit" && marketable) {
      return "limit_order_would_be_marketable";
    }
    if (input.orderType === "marketable_limit" && !marketable) {
      return "marketable_limit_does_not_cross_book";
    }
    if (
      input.side === "buy"
      && new Big(input.limitPrice).gt(bestBid)
      && input.orderType === "limit"
    ) {
      return "buy_limit_above_best_bid";
    }
    if (
      input.side === "sell"
      && new Big(input.limitPrice).lt(bestAsk)
      && input.orderType === "limit"
    ) {
      return "sell_limit_below_best_ask";
    }
    return null;
  }

  private getDailyRealizedNetPnl(
    portfolioId: string,
    quoteAssetId: string,
    pairId: string,
    book: OrderBookSnapshot,
    nowMs: number,
  ): Big | null {
    const date = new Date(nowMs);
    const dayStartMs = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    );
    const realizedRows = this.database.prepare(`
      SELECT gross_pnl_quote AS grossPnlQuote
      FROM paper_realized_pnl
      WHERE portfolio_id = ? AND quote_asset_id = ?
        AND created_at_ms >= ? AND created_at_ms <= ?
    `).all(portfolioId, quoteAssetId, dayStartMs, nowMs) as {
      grossPnlQuote: string | null;
    }[];
    let netPnl = new Big(0);
    for (const row of realizedRows) {
      if (row.grossPnlQuote === null) {
        return null;
      }
      netPnl = netPnl.plus(row.grossPnlQuote);
    }

    const feeRows = this.database.prepare(`
      SELECT f.estimated_fee_quote AS feeQuote
      FROM paper_fee_entries f
      JOIN paper_orders o ON o.order_id = f.order_id
      WHERE o.portfolio_id = ? AND f.quote_asset_id = ?
        AND f.created_at_ms >= ? AND f.created_at_ms <= ?
    `).all(portfolioId, quoteAssetId, dayStartMs, nowMs) as {
      feeQuote: string | null;
    }[];
    for (const row of feeRows) {
      if (row.feeQuote === null) {
        return null;
      }
      netPnl = netPnl.minus(row.feeQuote);
    }

    const positionPairs = this.database.prepare(`
      SELECT DISTINCT pair_id AS pairId
      FROM paper_lots
      WHERE portfolio_id = ? AND quote_asset_id = ? AND remaining_base != '0'
    `).all(portfolioId, quoteAssetId) as { pairId: string }[];
    if (positionPairs.some((position) => position.pairId !== pairId)) {
      return null;
    }
    const quotePairs = this.database.prepare(`
      SELECT pair_id AS pairId, base_asset_id AS baseAssetId
      FROM trading_pairs WHERE quote_asset_id = ?
    `).all(quoteAssetId) as { pairId: string; baseAssetId: string }[];
    for (const candidate of quotePairs) {
      if (candidate.pairId === pairId) {
        continue;
      }
      const otherBalance = this.database.prepare(`
        SELECT available, reserved FROM paper_balances
        WHERE portfolio_id = ? AND asset_id = ?
      `).get(portfolioId, candidate.baseAssetId) as {
        available: string;
        reserved: string;
      } | undefined;
      if (
        new Big(otherBalance?.available ?? "0")
          .plus(otherBalance?.reserved ?? "0")
          .gt(0)
      ) {
        return null;
      }
    }
    const pair = this.database.prepare(`
      SELECT base_asset_id AS baseAssetId FROM trading_pairs WHERE pair_id = ?
    `).get(pairId) as { baseAssetId: string } | undefined;
    if (!pair) {
      return null;
    }
    const balance = this.database.prepare(`
      SELECT available, reserved FROM paper_balances
      WHERE portfolio_id = ? AND asset_id = ?
    `).get(portfolioId, pair.baseAssetId) as {
      available: string;
      reserved: string;
    } | undefined;
    const inventory = new Big(balance?.available ?? "0").plus(balance?.reserved ?? "0");
    const lots = this.database.prepare(`
      SELECT remaining_base AS remainingBase, unit_cost_quote AS unitCostQuote
      FROM paper_lots WHERE portfolio_id = ? AND pair_id = ? AND remaining_base != '0'
    `).all(portfolioId, pairId) as {
      remainingBase: string;
      unitCostQuote: string | null;
    }[];
    const lotInventory = lots.reduce(
      (total, lot) => total.plus(lot.remainingBase),
      new Big(0),
    );
    if (inventory.gt(lotInventory)) {
      return null;
    }
    const inventoryDifference = lotInventory.minus(inventory);
    if (inventoryDifference.gt(0)) {
      if (pair.baseAssetId !== "native") {
        return null;
      }
      const nativeFees = this.database.prepare(`
        SELECT f.estimated_fee_xlm AS feeXlm
        FROM paper_fee_entries f
        JOIN paper_orders o ON o.order_id = f.order_id
        WHERE o.portfolio_id = ?
      `).all(portfolioId) as { feeXlm: string }[];
      const totalNativeFees = nativeFees.reduce(
        (total, fee) => total.plus(fee.feeXlm),
        new Big(0),
      );
      if (inventoryDifference.gt(totalNativeFees)) {
        return null;
      }
    }
    if (inventory.gt(0)) {
      if (lots.some((lot) => lot.unitCostQuote === null)) {
        return null;
      }
      if (validateOrderBookIntegrity(book, this.config.maxOrderBookAgeMs, nowMs).length > 0) {
        return null;
      }
      const liquidation = estimateExecutableVolume(book, "sell", inventory.toString());
      if (!liquidation.complete) {
        return null;
      }
      let costBasis = new Big(0);
      for (const lot of lots) {
        if (lot.unitCostQuote === null) {
          return null;
        }
        costBasis = costBasis.plus(new Big(lot.remainingBase).times(lot.unitCostQuote));
      }
      if (inventory.lt(lotInventory)) {
        costBasis = costBasis.times(inventory).div(lotInventory);
      }
      netPnl = netPnl.plus(liquidation.quoteAmount).minus(costBasis);
    }
    return netPnl;
  }

  private dailyLossLimitReached(
    portfolioId: string,
    quoteAssetId: string,
    pairId: string,
    book: OrderBookSnapshot,
    nowMs: number,
  ): boolean {
    const dailyLossLimit = this.config.paperMaxDailyLossByQuote[quoteAssetId];
    if (!dailyLossLimit) {
      return true;
    }
    const dailyPnl = this.getDailyRealizedNetPnl(
      portfolioId,
      quoteAssetId,
      pairId,
      book,
      nowMs,
    );
    return dailyPnl === null || dailyPnl.lte(new Big(dailyLossLimit).neg());
  }

  private reserveOrderAndFees(input: {
    orderId: string;
    portfolioId: string;
    reserveAssetId: string;
    orderReserve: Big;
    feeAssetId: string;
    totalFeeReserve: Big;
    futureFeeReserve: Big;
    feeXlm: Big;
    feeQuoteAssetId: string;
    feeQuotePerXlm: string;
    feeConversionSnapshotId: number | null;
    feeOperationStroops: string;
    nowMs: number;
  }): void {
    this.moveBalance({
      order: { order_id: input.orderId, portfolio_id: input.portfolioId },
      assetId: input.reserveAssetId,
      from: "available",
      to: "reserved",
      amount: input.orderReserve,
      key: `order:${input.orderId}:reserve`,
      entryType: "order_reservation",
      nowMs: input.nowMs,
    });
    applyBalanceDelta({
      database: this.database,
      portfolioId: input.portfolioId,
      assetId: input.feeAssetId,
      bucket: "available",
      delta: input.totalFeeReserve.neg(),
      entryType: "estimated_fee_debit_and_reserve",
      referenceType: "paper_order",
      referenceId: input.orderId,
      idempotencyKey: `order:${input.orderId}:fee-lifecycle`,
      nowMs: input.nowMs,
    });
    if (input.futureFeeReserve.gt(0)) {
      applyBalanceDelta({
        database: this.database,
        portfolioId: input.portfolioId,
        assetId: input.feeAssetId,
        bucket: "reserved",
        delta: input.futureFeeReserve,
        entryType: "estimated_fee_reserve",
        referenceType: "paper_order",
        referenceId: input.orderId,
        idempotencyKey: `order:${input.orderId}:fee-reserve`,
        nowMs: input.nowMs,
      });
    }
    this.insertFeeEntry({
      orderId: input.orderId,
      eventType: "placement",
      operationFeeStroops: input.feeOperationStroops,
      feeXlm: input.feeXlm,
      quoteAssetId: input.feeQuoteAssetId,
      quotePerXlm: input.feeQuotePerXlm,
      conversionSnapshotId: input.feeConversionSnapshotId,
      idempotencyKey: `order:${input.orderId}:fee:placement`,
      nowMs: input.nowMs,
    });
  }

  private fillFromDisplayedDepth(input: {
    orderId: string;
    book: OrderBookSnapshot;
    snapshotId: number;
    nowMs: number;
  }): void {
    const order = this.getOrder(input.orderId);
    const levels = order.side === "buy" ? input.book.asks : input.book.bids;
    let remaining = new Big(order.remaining_base);
    let levelIndex = 0;
    for (const level of levels) {
      if (!remaining.gt(0)) {
        break;
      }
      const price = new Big(level.price);
      const withinLimit = order.side === "buy"
        ? price.lte(order.limit_price)
        : price.gte(order.limit_price);
      if (!withinLimit) {
        break;
      }
      const allocated = this.database.prepare(`
        SELECT base_amount
        FROM paper_depth_allocations
        WHERE snapshot_id = ? AND pair_id = ? AND side = ? AND level_index = ?
      `).all(
        input.snapshotId,
        order.pair_id,
        order.side,
        levelIndex,
      ) as { base_amount: string }[];
      const alreadyAllocated = allocated.reduce(
        (total, allocation) => total.plus(allocation.base_amount),
        new Big(0),
      );
      const levelAmount = new Big(level.amount);
      const available = levelAmount.minus(alreadyAllocated);
      if (!available.gt(0)) {
        levelIndex += 1;
        continue;
      }
      const fill = available.lt(remaining) ? available : remaining;
      if (fill.gt(0)) {
        this.applyFill({
          orderId: order.order_id,
          fillBase: fill,
          price,
          tradeId: null,
          snapshotId: input.snapshotId,
          sourceKind: "book_depth",
          idempotencyKey: `book:${order.order_id}:${input.snapshotId}:${levelIndex}`,
          nowMs: input.nowMs,
        });
        this.database.prepare(`
          INSERT INTO paper_depth_allocations (
            snapshot_id, pair_id, side, level_index, order_id, base_amount
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.snapshotId,
          order.pair_id,
          order.side,
          levelIndex,
          order.order_id,
          fill.toString(),
        );
        remaining = remaining.minus(fill);
      }
      levelIndex += 1;
    }
  }

  private applyFill(input: {
    orderId: string;
    fillBase: Big;
    price: Big;
    tradeId: string | null;
    snapshotId: number;
    sourceKind: "trade" | "book_depth";
    idempotencyKey: string;
    nowMs: number;
  }): void {
    if (!input.fillBase.gt(0) || !input.price.gt(0)) {
      throw new Error("Paper fills require positive amounts and prices");
    }
    const duplicate = this.database.prepare(`
      SELECT 1 FROM paper_fills WHERE idempotency_key = ?
    `).get(input.idempotencyKey);
    if (duplicate) {
      return;
    }
    const order = this.getOrder(input.orderId);
    if (order.status !== "open" && order.status !== "partially_filled") {
      return;
    }
    if (input.fillBase.gt(order.remaining_base)) {
      throw new Error("Paper fill exceeds the order's remaining amount");
    }
    if (
      (order.side === "buy" && input.price.gt(order.limit_price))
      || (order.side === "sell" && input.price.lt(order.limit_price))
    ) {
      throw new Error("Paper fill price violates the order limit");
    }
    const pair = this.getPairAssets(order.pair_id);
    const fillId = randomUUID();
    const quoteAmount = input.fillBase.times(input.price);
    this.database.prepare(`
      INSERT INTO paper_fills (
        fill_id, idempotency_key, order_id, trade_id, snapshot_id, source_kind,
        base_amount, price, quote_amount, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fillId,
      input.idempotencyKey,
      order.order_id,
      input.tradeId,
      input.snapshotId,
      input.sourceKind,
      input.fillBase.toString(),
      input.price.toString(),
      quoteAmount.toString(),
      input.nowMs,
    );

    if (order.side === "buy") {
      const reservedAtLimit = input.fillBase.times(order.limit_price);
      const priceImprovement = reservedAtLimit.minus(quoteAmount);
      this.ledgerDelta(order, pair.quote_asset_id, "reserved", reservedAtLimit.neg(), `fill:${fillId}:quote-reserved`, "fill_quote_spent", input.nowMs);
      if (priceImprovement.gt(0)) {
        this.ledgerDelta(order, pair.quote_asset_id, "available", priceImprovement, `fill:${fillId}:quote-improvement`, "fill_price_improvement", input.nowMs);
      }
      this.ledgerDelta(order, pair.base_asset_id, "available", input.fillBase, `fill:${fillId}:base-received`, "fill_base_received", input.nowMs);
      this.database.prepare(`
        INSERT INTO paper_lots (
          lot_id, portfolio_id, pair_id, source_fill_id, base_asset_id,
          quote_asset_id, original_base, remaining_base, unit_cost_quote, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        order.portfolio_id,
        order.pair_id,
        fillId,
        pair.base_asset_id,
        pair.quote_asset_id,
        input.fillBase.toString(),
        input.fillBase.toString(),
        input.price.toString(),
        input.nowMs,
      );
    } else {
      this.ledgerDelta(order, pair.base_asset_id, "reserved", input.fillBase.neg(), `fill:${fillId}:base-sold`, "fill_base_sold", input.nowMs);
      this.ledgerDelta(order, pair.quote_asset_id, "available", quoteAmount, `fill:${fillId}:quote-received`, "fill_quote_received", input.nowMs);
      this.consumeLots({
        order,
        fillId,
        baseAmount: input.fillBase,
        quoteAmount,
        quoteAssetId: pair.quote_asset_id,
        nowMs: input.nowMs,
      });
    }

    const filledBase = new Big(order.filled_base).plus(input.fillBase);
    const remainingBase = new Big(order.remaining_base).minus(input.fillBase);
    const status = remainingBase.eq(0) ? "filled" : "partially_filled";
    this.database.prepare(`
      UPDATE paper_orders
      SET filled_base = ?, remaining_base = ?, status = ?, updated_at_ms = ?
      WHERE order_id = ?
    `).run(filledBase.toString(), remainingBase.toString(), status, input.nowMs, order.order_id);
    this.recordOrderEvent({
      orderId: order.order_id,
      eventType: "fill",
      fromStatus: order.status,
      toStatus: status,
      snapshotId: input.snapshotId,
      tradeId: input.tradeId,
      payload: {
        fillId,
        baseAmount: input.fillBase.toString(),
        price: input.price.toString(),
        quoteAmount: quoteAmount.toString(),
      },
      nowMs: input.nowMs,
    });
    if (status === "filled") {
      this.releaseFutureFees(order, input.nowMs);
    }
  }

  private consumeLots(input: {
    order: PaperOrderRow;
    fillId: string;
    baseAmount: Big;
    quoteAmount: Big;
    quoteAssetId: string;
    nowMs: number;
  }): void {
    const { order } = input;
    let remainingToConsume = input.baseAmount;
    const lots = this.database.prepare(`
      SELECT lot_id, remaining_base, unit_cost_quote, quote_asset_id
      FROM paper_lots
      WHERE portfolio_id = ? AND base_asset_id = ?
      ORDER BY created_at_ms, rowid
    `).all(order.portfolio_id, this.getPairAssets(order.pair_id).base_asset_id) as {
      lot_id: string;
      remaining_base: string;
      unit_cost_quote: string | null;
      quote_asset_id: string;
    }[];
    let availableLots = lots.reduce(
      (total, lot) => total.plus(lot.remaining_base),
      new Big(0),
    );
    if (availableLots.lt(input.baseAmount)) {
      const openingAmount = input.baseAmount.minus(availableLots);
      const openingLotId = randomUUID();
      this.database.prepare(`
        INSERT INTO paper_lots (
          lot_id, portfolio_id, pair_id, source_fill_id, base_asset_id,
          quote_asset_id, original_base, remaining_base, unit_cost_quote, created_at_ms
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)
      `).run(
        openingLotId,
        order.portfolio_id,
        order.pair_id,
        this.getPairAssets(order.pair_id).base_asset_id,
        input.quoteAssetId,
        openingAmount.toString(),
        openingAmount.toString(),
        input.nowMs,
      );
      lots.push({
        lot_id: openingLotId,
        remaining_base: openingAmount.toString(),
        unit_cost_quote: null,
        quote_asset_id: input.quoteAssetId,
      });
      availableLots = availableLots.plus(openingAmount);
    }

    let costQuote = new Big(0);
    let costComplete = true;
    for (const lot of lots) {
      if (!remainingToConsume.gt(0)) {
        break;
      }
      const lotRemaining = new Big(lot.remaining_base);
      if (!lotRemaining.gt(0)) {
        continue;
      }
      const consumed = lotRemaining.lt(remainingToConsume) ? lotRemaining : remainingToConsume;
      if (
        lot.unit_cost_quote === null
        || lot.quote_asset_id !== input.quoteAssetId
      ) {
        costComplete = false;
      } else {
        costQuote = costQuote.plus(consumed.times(lot.unit_cost_quote));
      }
      this.database.prepare(`
        UPDATE paper_lots SET remaining_base = ? WHERE lot_id = ?
      `).run(lotRemaining.minus(consumed).toString(), lot.lot_id);
      remainingToConsume = remainingToConsume.minus(consumed);
    }
    if (!remainingToConsume.eq(0)) {
      throw new Error("Inventory lots do not reconcile with the simulated balance");
    }
    const grossPnl = costComplete ? input.quoteAmount.minus(costQuote).toString() : null;
    this.database.prepare(`
      INSERT INTO paper_realized_pnl (
        fill_id, portfolio_id, pair_id, quote_asset_id, sold_base, gross_pnl_quote, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.fillId,
      order.portfolio_id,
      order.pair_id,
      input.quoteAssetId,
      input.baseAmount.toString(),
      grossPnl,
      input.nowMs,
    );
  }

  private getOpenOrdersForTrade(pairId: string, baseIsSeller: boolean): PaperOrderRow[] {
    const side = baseIsSeller ? "buy" : "sell";
    const orders = this.database.prepare(`
      SELECT * FROM paper_orders
      WHERE pair_id = ? AND side = ? AND status IN ('open', 'partially_filled')
    `).all(pairId, side) as PaperOrderRow[];
    return orders.sort((left, right) => {
      const priceOrder = new Big(left.limit_price).cmp(right.limit_price);
      if (priceOrder !== 0) {
        return side === "buy" ? -priceOrder : priceOrder;
      }
      return left.created_at_ms - right.created_at_ms;
    });
  }

  private computeQueueAhead(
    book: OrderBookSnapshot,
    side: "buy" | "sell",
    limitPrice: Big,
    pairId: string,
  ): Big {
    const levels = side === "buy" ? book.bids : book.asks;
    let queue = levels.reduce((total, level) => {
      const price = new Big(level.price);
      const ahead = side === "buy" ? price.gte(limitPrice) : price.lte(limitPrice);
      return ahead ? total.plus(level.amount) : total;
    }, new Big(0));
    const openOrders = this.database.prepare(`
      SELECT side, limit_price, remaining_base
      FROM paper_orders
      WHERE pair_id = ? AND side = ? AND status IN ('open', 'partially_filled')
    `).all(pairId, side) as { side: "buy" | "sell"; limit_price: string; remaining_base: string }[];
    for (const order of openOrders) {
      const existingPrice = new Big(order.limit_price);
      const ahead = side === "buy"
        ? existingPrice.gte(limitPrice)
        : existingPrice.lte(limitPrice);
      if (ahead) {
        queue = queue.plus(order.remaining_base);
      }
    }
    return queue;
  }

  private moveBalance(input: {
    order: Pick<PaperOrderRow, "order_id" | "portfolio_id">;
    assetId: string;
    from: "available" | "reserved";
    to: "available" | "reserved";
    amount: Big;
    key: string;
    entryType: string;
    nowMs: number;
  }): void {
    applyBalanceDelta({
      database: this.database,
      portfolioId: input.order.portfolio_id,
      assetId: input.assetId,
      bucket: input.from,
      delta: input.amount.neg(),
      entryType: input.entryType,
      referenceType: "paper_order",
      referenceId: input.order.order_id,
      idempotencyKey: `${input.key}:${input.from}`,
      nowMs: input.nowMs,
    });
    applyBalanceDelta({
      database: this.database,
      portfolioId: input.order.portfolio_id,
      assetId: input.assetId,
      bucket: input.to,
      delta: input.amount,
      entryType: input.entryType,
      referenceType: "paper_order",
      referenceId: input.order.order_id,
      idempotencyKey: `${input.key}:${input.to}`,
      nowMs: input.nowMs,
    });
  }

  private ledgerDelta(
    order: PaperOrderRow,
    assetId: string,
    bucket: "available" | "reserved",
    delta: Big,
    key: string,
    entryType: string,
    nowMs: number,
  ): void {
    applyBalanceDelta({
      database: this.database,
      portfolioId: order.portfolio_id,
      assetId,
      bucket,
      delta,
      entryType,
      referenceType: "paper_order",
      referenceId: order.order_id,
      idempotencyKey: key,
      nowMs,
    });
  }

  private releaseFutureFees(order: PaperOrderRow, nowMs: number): void {
    const reservedFee = new Big(order.reserved_fee_xlm);
    if (reservedFee.gt(0)) {
      this.moveBalance({
        order,
        assetId: "native",
        from: "reserved",
        to: "available",
        amount: reservedFee,
        key: `order:${order.order_id}:fee-release`,
        entryType: "estimated_fee_reservation_released",
        nowMs,
      });
      this.database.prepare(`
        UPDATE paper_orders
        SET reserved_fee_xlm = '0', fee_operations_remaining = 0, updated_at_ms = ?
        WHERE order_id = ?
      `).run(nowMs, order.order_id);
    }
  }

  private consumeFutureFee(
    order: PaperOrderRow,
    eventType: "replacement" | "cancellation",
    nowMs: number,
  ): void {
    const feeXlm = new Big(order.fee_operation_stroops).div(10_000_000);
    const reserved = new Big(order.reserved_fee_xlm);
    if (reserved.lt(feeXlm)) {
      throw new Error("Reserved virtual XLM is insufficient for the lifecycle fee");
    }
    const key = `order:${order.order_id}:fee:${eventType}:${order.fee_operations_remaining}`;
    const quoteAssetId = this.getPairAssets(order.pair_id).quote_asset_id;
    const conversionSnapshot = order.fee_conversion_snapshot_id === null
      ? undefined
      : this.getSnapshot(order.fee_conversion_snapshot_id);
    const conversionIsFresh = quoteAssetId === "native"
      || (
        conversionSnapshot !== undefined
        && conversionSnapshot.integrity_status === "valid"
        && nowMs - conversionSnapshot.received_at_ms >= 0
        && nowMs - conversionSnapshot.received_at_ms <= this.config.maxOrderBookAgeMs
      );
    applyBalanceDelta({
      database: this.database,
      portfolioId: order.portfolio_id,
      assetId: "native",
      bucket: "reserved",
      delta: feeXlm.neg(),
      entryType: "estimated_network_fee",
      referenceType: "paper_order",
      referenceId: order.order_id,
      idempotencyKey: `${key}:debit`,
      nowMs,
    });
    this.insertFeeEntry({
      orderId: order.order_id,
      eventType,
      operationFeeStroops: order.fee_operation_stroops,
      feeXlm,
      quoteAssetId,
      quotePerXlm: conversionIsFresh ? order.fee_quote_per_xlm : null,
      conversionSnapshotId: order.fee_conversion_snapshot_id,
      idempotencyKey: key,
      nowMs,
    });
    this.database.prepare(`
      UPDATE paper_orders
      SET reserved_fee_xlm = ?, fee_operations_remaining = fee_operations_remaining - 1
      WHERE order_id = ?
    `).run(reserved.minus(feeXlm).toString(), order.order_id);
  }

  private insertFeeEntry(input: {
    orderId: string;
    eventType: "placement" | "replacement" | "cancellation";
    operationFeeStroops: string;
    feeXlm: Big;
    quoteAssetId: string;
    quotePerXlm: string | null;
    conversionSnapshotId: number | null;
    idempotencyKey: string;
    nowMs: number;
  }): void {
    const quoteAmount = input.quotePerXlm === null
      ? null
      : input.feeXlm.times(input.quotePerXlm).toString();
    this.database.prepare(`
      INSERT INTO paper_fee_entries (
        fee_entry_id, idempotency_key, order_id, event_type, operation_fee_stroops,
        estimated_fee_xlm, quote_asset_id, xlm_to_quote_rate, estimated_fee_quote,
        conversion_snapshot_id, nature, actual_fee_xlm, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'simulated_estimate', NULL, ?)
    `).run(
      randomUUID(),
      input.idempotencyKey,
      input.orderId,
      input.eventType,
      input.operationFeeStroops,
      input.feeXlm.toString(),
      input.quoteAssetId,
      input.quotePerXlm,
      quoteAmount,
      input.conversionSnapshotId,
      input.nowMs,
    );
  }

  private insertOrder(input: {
    orderId: string;
    clientOrderKey: string;
    portfolioId: string;
    pairId: string;
    decisionId: string | null;
    orderType: "limit" | "marketable_limit";
    side: "buy" | "sell";
    limitPrice: string;
    baseAmount: string;
    queueAhead: string;
    operationFeeStroops: string;
    quotePerXlm: string;
    feeConversionSnapshotId: number | null;
    futureFeeReserve: string;
    feeOperationsRemaining: number;
    maxReplacements: number;
    status: PaperOrderReceipt["status"];
    snapshotId: number;
    nowMs: number;
  }): void {
    this.database.prepare(`
      INSERT INTO paper_orders (
        order_id, client_order_key, portfolio_id, pair_id, decision_id, order_type,
        side, limit_price, requested_base, filled_base, remaining_base,
        queue_ahead_base, queue_consumed_base, fee_operation_stroops,
        fee_quote_per_xlm, fee_conversion_snapshot_id, reserved_fee_xlm,
        fee_operations_remaining, max_replacements, status, placement_snapshot_id,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.orderId,
      input.clientOrderKey,
      input.portfolioId,
      input.pairId,
      input.decisionId,
      input.orderType,
      input.side,
      input.limitPrice,
      input.baseAmount,
      input.baseAmount,
      input.queueAhead,
      input.operationFeeStroops,
      input.quotePerXlm,
      input.feeConversionSnapshotId,
      input.futureFeeReserve,
      input.feeOperationsRemaining,
      input.maxReplacements,
      input.status,
      input.snapshotId,
      input.nowMs,
      input.nowMs,
    );
  }

  private recordOrderEvent(input: {
    orderId: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    snapshotId: number | null;
    tradeId: string | null;
    payload: unknown;
    nowMs: number;
  }): void {
    this.database.prepare(`
      INSERT INTO paper_order_events (
        order_id, event_type, from_status, to_status, snapshot_id, trade_id,
        payload_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.orderId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.snapshotId,
      input.tradeId,
      JSON.stringify(input.payload),
      input.nowMs,
    );
  }

  private pauseOpenOrders(
    pairId: string,
    snapshotId: number,
    tradeId: string | null,
    reason: string,
    nowMs: number,
  ): number {
    const orders = this.database.prepare(`
      SELECT order_id, status FROM paper_orders
      WHERE pair_id = ? AND status IN ('open', 'partially_filled')
    `).all(pairId) as { order_id: string; status: string }[];
    for (const order of orders) {
      this.database.prepare(`
        UPDATE paper_orders SET status = 'paused', updated_at_ms = ? WHERE order_id = ?
      `).run(nowMs, order.order_id);
      this.recordOrderEvent({
        orderId: order.order_id,
        eventType: "paused_market_integrity",
        fromStatus: order.status,
        toStatus: "paused",
        snapshotId,
        tradeId,
        payload: { reason },
        nowMs,
      });
    }
    return orders.length;
  }

  private advanceTradeCursor(pairId: string, cursor: string, nowMs: number): void {
    const current = this.database.prepare(`
      SELECT trade_cursor FROM stream_cursors WHERE pair_id = ?
    `).get(pairId) as { trade_cursor: string } | undefined;
    const cursorValue = /^\d+$/.test(cursor) ? BigInt(cursor) : null;
    const currentValue = current && /^\d+$/.test(current.trade_cursor)
      ? BigInt(current.trade_cursor)
      : null;
    const next = !current
      ? cursor
      : cursorValue !== null && (currentValue === null || cursorValue > currentValue)
        ? cursor
        : current.trade_cursor;
    this.database.prepare(`
      INSERT INTO stream_cursors (pair_id, trade_cursor, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET trade_cursor = excluded.trade_cursor,
        updated_at_ms = excluded.updated_at_ms
    `).run(pairId, next, nowMs);
  }

  private getOrder(orderId: string): PaperOrderRow {
    const order = this.database.prepare(`
      SELECT * FROM paper_orders WHERE order_id = ?
    `).get(orderId) as PaperOrderRow | undefined;
    if (!order) {
      throw new Error(`Unknown paper order ${orderId}`);
    }
    return order;
  }

  private getOrderReceipt(
    orderId: string,
    duplicate: boolean,
    reason: string | null,
  ): PaperOrderReceipt {
    const order = this.getOrder(orderId);
    return { orderId, status: order.status, duplicate, reason };
  }

  private getPairAssets(pairId: string): PairAssets {
    const pair = this.database.prepare(`
      SELECT base_asset_id, quote_asset_id FROM trading_pairs WHERE pair_id = ?
    `).get(pairId) as PairAssets | undefined;
    if (!pair) {
      throw new Error(`Unknown trading pair ${pairId}`);
    }
    return pair;
  }

  private getSnapshot(snapshotId: number): SnapshotRow {
    const snapshot = this.database.prepare(`
      SELECT pair_id, integrity_status, received_at_ms, content_hash
      FROM market_snapshots WHERE id = ?
    `).get(snapshotId) as SnapshotRow | undefined;
    if (!snapshot) {
      throw new Error(`Unknown market snapshot ${snapshotId}`);
    }
    return snapshot;
  }
}

function positiveDecimal(value: string, field: string): Big {
  let parsed: Big;
  try {
    parsed = new Big(value);
  } catch (error) {
    throw new Error(`${field} must be a decimal amount`, { cause: error });
  }
  if (!parsed.gt(0)) {
    throw new Error(`${field} must be positive`);
  }
  return parsed;
}

function contentHash(book: OrderBookSnapshot): string {
  return createHash("sha256").update(JSON.stringify(book)).digest("hex");
}
