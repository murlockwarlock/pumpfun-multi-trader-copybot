import assert from "node:assert/strict";
import test from "node:test";

// Small deterministic transition model for the ownership policy.  It is
// intentionally independent of RPC and wall-clock state: a failing seed can
// be replayed by printing the event list below.
class InventoryModel {
  constructor() {
    this.mints = new Map();
    this.capitalReserved = 0n;
    this.capitalRefunded = new Set();
    this.pnl = 0n;
  }

  mint(address) {
    return this.mints.get(address) ?? this.mints.set(address, {
      balance: 0n, baseline: null, bought: 0n, sold: 0n, available: 0n,
      quarantined: false, quarantineReason: null, buySignatures: new Set(),
      sellSignatures: new Set(), pendingBuy: null, pendingSell: null,
      buyStages: new Set(), buySettled: false
    }).get(address);
  }

  apply(event) {
    const item = this.mint(event.mint);
    switch (event.type) {
      case "BUY_SUBMITTED":
        if (!item.quarantined && !item.buySignatures.has(event.signature)) {
          item.buySignatures.add(event.signature);
          if (item.balance === 0n && event.baseline !== null) item.balance = event.baseline;
          item.balance += event.delta;
          item.pendingBuy = {
            signature: event.signature,
            delta: event.delta,
            baseline: event.baseline,
            capital: event.capital
          };
          this.capitalReserved += event.capital;
        }
        break;
      case "BUY_PROCESSED":
      case "BUY_CONFIRMED": {
        if (item.buyStages.has(event.type) || item.buySettled) break;
        item.buyStages.add(event.type);
        const buy = item.pendingBuy;
        if (!buy || item.quarantined) break;
        if (buy.baseline === null) {
          item.quarantined = true;
          item.quarantineReason = "inventory_baseline_unproven";
          break;
        }
        item.baseline = buy.baseline;
        if (item.balance < buy.baseline + buy.delta) {
          item.quarantined = true;
          item.quarantineReason = "post_buy_inventory_ambiguous";
          break;
        }
        item.bought += buy.delta;
        item.available += buy.delta;
        item.buySettled = true;
        break;
      }
      case "BUY_FAILED":
        if (item.pendingBuy?.signature === event.signature && !item.buySettled &&
            !this.capitalRefunded.has(event.signature)) {
          this.capitalRefunded.add(event.signature);
          this.capitalReserved -= event.capital;
          item.pendingBuy = null;
        }
        break;
      case "SELL_REQUESTED":
        if (!item.quarantined && item.available > 0n && !item.pendingSell) {
          item.pendingSell = { signature: event.signature, amount: event.amount };
        }
        break;
      case "SELL_SUBMITTED":
        if (!item.quarantined && item.pendingSell?.signature === event.signature) {
          item.sellSignatures.add(event.signature);
        }
        break;
      case "SELL_CONFIRMED": {
        if (item.quarantined || !item.sellSignatures.has(event.signature)) break;
        if (event.amount > item.available) {
          item.quarantined = true;
          item.quarantineReason = "sell_delta_exceeds_owned_inventory";
          break;
        }
        item.sold += event.amount;
        item.available -= event.amount;
        item.pendingSell = null;
        this.pnl += event.amount;
        break;
      }
      case "SELL_FAILED":
        if (item.pendingSell?.signature === event.signature) item.pendingSell = null;
        break;
      case "SELL_UNKNOWN":
      case "RPC_TIMEOUT":
      case "RECONCILIATION":
      case "WS_REPEAT":
        // Unknown outcomes and unavailable metadata never create ownership or
        // PnL evidence, and reconciliation never clears quarantine.
        break;
      case "EXTERNAL_IN":
        item.balance += event.amount;
        break;
      case "EXTERNAL_OUT":
        item.balance = item.balance > event.amount ? item.balance - event.amount : 0n;
        if (!item.quarantined && item.baseline !== null &&
            item.balance < item.baseline + item.available) {
          item.quarantined = true;
          item.quarantineReason = "out_of_band_inventory_change";
        }
        break;
      case "RESTART":
        // The production state is JSON durable.  Copying all scalar/set state
        // here models a restart without introducing a second persistence lib.
        this.mints = new Map([...this.mints].map(([mint, value]) => [mint, {
          ...value, buySignatures: new Set(value.buySignatures),
          sellSignatures: new Set(value.sellSignatures), buyStages: new Set(value.buyStages),
          pendingBuy: value.pendingBuy && { ...value.pendingBuy },
          pendingSell: value.pendingSell && { ...value.pendingSell },
          buySettled: value.buySettled
        }]));
        break;
      default:
        throw new Error(`unknown event ${event.type}`);
    }
  }
}

function next(seed) {
  return (seed * 1664525 + 1013904223) >>> 0;
}

function eventsForSeed(seed) {
  const baseline = seed % 3 === 0 ? null : 50n;
  const events = [
    { type: "BUY_SUBMITTED", mint: "A", signature: "buy-A", delta: 100n, baseline, capital: 5n },
    { type: "EXTERNAL_IN", mint: "A", amount: 30n },
    { type: "BUY_PROCESSED", mint: "A" },
    { type: "WS_REPEAT", mint: "A" },
    { type: "EXTERNAL_OUT", mint: "A", amount: seed % 2 ? 40n : 0n },
    { type: "BUY_CONFIRMED", mint: "A" },
    { type: "SELL_REQUESTED", mint: "A", signature: "sell-A-1", amount: 40n },
    { type: "SELL_SUBMITTED", mint: "A", signature: "sell-A-1" },
    { type: seed % 5 === 0 ? "SELL_UNKNOWN" : "SELL_CONFIRMED", mint: "A",
      signature: "sell-A-1", amount: 40n },
    { type: "RESTART", mint: "A" },
    { type: "EXTERNAL_IN", mint: "A", amount: 40n },
    { type: "SELL_REQUESTED", mint: "A", signature: "sell-A-2", amount: 60n },
    { type: "SELL_SUBMITTED", mint: "A", signature: "sell-A-2" },
    { type: "SELL_CONFIRMED", mint: "A", signature: "sell-A-2", amount: 60n },
    { type: "BUY_SUBMITTED", mint: "B", signature: "buy-B", delta: 20n, baseline: 20n, capital: 2n },
    { type: "BUY_PROCESSED", mint: "B" },
    { type: "RPC_TIMEOUT", mint: "A" },
    { type: "RECONCILIATION", mint: "A" },
    { type: "BUY_FAILED", mint: "B", signature: "buy-B", capital: 2n }
  ];
  // Deterministically shuffle the A lane while retaining lifecycle order for
  // the independent B lane.  This exercises cross-mint interleavings without
  // manufacturing an impossible B event sequence.
  const independent = [events[14], events[15], events[18]];
  const aEvents = [...events.slice(0, 14), events[16], events[17]];
  let cursor = seed;
  for (let i = aEvents.length - 1; i > 0; i--) {
    cursor = next(cursor);
    const index = cursor % (i + 1);
    [aEvents[i], aEvents[index]] = [aEvents[index], aEvents[i]];
  }
  const insertAt = next(cursor) % (aEvents.length + 1);
  aEvents.splice(insertAt, 0, ...independent);
  return aEvents;
}

function assertInvariants(model) {
  assert.ok(model.capitalReserved >= 0n);
  for (const item of model.mints.values()) {
    assert.ok(item.sold <= item.bought, "sold volume exceeds proven BUY volume");
    assert.ok(item.available >= 0n);
    assert.ok(item.sold + item.available <= item.bought);
    if (item.quarantined) {
      assert.equal(item.quarantineReason !== null, true);
      assert.equal(item.pendingSell === null || item.sellSignatures.has(item.pendingSell.signature), true);
    }
    for (const signature of item.sellSignatures) assert.equal(item.sellSignatures.has(signature), true);
  }
}

test("fixed-seed inventory transition model preserves ownership invariants", () => {
  const seeds = [0x10203040, 0x55667788, 0x90abcdef, 0xdeadbeef, ...Array.from({ length: 28 }, (_, i) => i + 1)];
  for (const seed of seeds) {
    const model = new InventoryModel();
    const events = eventsForSeed(seed);
    for (const event of events) {
      model.apply(event);
      assertInvariants(model);
      if (model.mint("A").quarantined) {
        const before = model.mint("A").buySignatures.size;
        model.apply({ type: "BUY_SUBMITTED", mint: "A", signature: `new-${seed}`, delta: 1n, baseline: 0n, capital: 1n });
        assert.equal(model.mint("A").buySignatures.size, before);
        assert.equal(model.mint("A").pendingBuy.signature, "buy-A");
        assert.equal(model.mint("A").quarantined, true);
      }
    }
    assert.equal(model.mint("B").bought, 20n, `independent mint B was blocked for seed ${seed}`);
  }
  assert.equal(seeds.length, 32);
});
