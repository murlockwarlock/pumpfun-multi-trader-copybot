import assert from "node:assert/strict";
import test from "node:test";
import { quoteCurveBuyAfter, quoteCurveSellAfter } from "../src/curve-quote.js";

function curveTrade(virtualSol, virtualTokens) {
  return {
    curveState: {
      virtualSolReservesRaw: String(Math.round(virtualSol * 1e9)),
      virtualTokenReservesRaw: String(Math.round(virtualTokens * 1e6)),
      feeBasisPoints: 125,
      creatorFeeBasisPoints: 50
    }
  };
}

test("quotes a copy against post-target Pump reserves", () => {
  const buy = quoteCurveBuyAfter(
    curveTrade(35, 919_714_285.714286),
    0.005,
    125
  );
  assert.ok(buy.tokenAmount > 100_000);
  assert.equal(buy.feeBps, 175);
  assert.equal(buy.source, "curve_post_event");

  const sell = quoteCurveSellAfter(
    curveTrade(46.465555093, 692_771_235.360945),
    buy.tokenAmount,
    125
  );
  assert.ok(sell.proceedsSol > 0.008);
  const pnl = sell.proceedsSol - 0.00011 - (0.005 + 0.00011);
  assert.ok(pnl > 0.0025);
});

test("fails closed when reserve telemetry is unavailable", () => {
  assert.equal(quoteCurveBuyAfter({}, 0.005, 125), null);
  assert.equal(quoteCurveSellAfter({}, 100, 125), null);
});
