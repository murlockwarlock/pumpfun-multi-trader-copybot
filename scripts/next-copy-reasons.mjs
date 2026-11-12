export function observationReason(reason) {
  const r=String(reason??"").toLowerCase();
  if (/429|rate.limit|provider_cooldown/.test(r)) return "RPC_429";
  if (/queue_(full|deadline)/.test(r)) return "VERIFICATION_QUEUE";
  if (/overlapping_mint/.test(r)) return "REPEAT_OPEN_POSITION";
  if (/position_budget/.test(r)) return "POSITION_CAP";
  if (/rpc_budget|verification_budget/.test(r)) return "OWN_RPC_BUDGET";
  if (/late_or_unproven_context/.test(r)) return "DEADLINE_OR_CONTEXT_UNDISTINGUISHED";
  if (/deadline/.test(r)) return "DEADLINE";
  if (/min.context.slot|market_slot_unproven|confirmed_state|mint account not found|minimum context slot/.test(r)) return "CONFIRMED_STATE_UNAVAILABLE";
  if (/liquidity|reserves|unsupported|only sol.quoted|curve unavailable|migrated|legacy pumpswap/.test(r)) return "MARKET_OR_LIQUIDITY";
  if (/exceeds.*price|invalid_minimum/.test(r)) return "PRICE_LIMIT";
  if (/source_transaction_missing|source_transaction_mismatch|log_trade_mismatch/.test(r)) return "SOURCE_MISSING_OR_MISMATCH";
  if (/verification_unavailable/.test(r)) return "SOURCE_OR_RPC_UNDISTINGUISHED";
  if (/subscription_gap/.test(r)) return "WS_GAP";
  if (/no_verified_target_sell/.test(r)) return "TARGET_SELL_NOT_SEEN";
  if (/timeout|aborted|http_|fetch failed|rpc_error|failed to get/.test(r)) return "RPC_ERROR";
  return "OTHER";
}

export function quoteFailure(quote,slot,dueAt,now,deadline) {
  if (now<dueAt || now-dueAt>deadline) return "quote_deadline";
  if (quote.contextVerified!==true || quote.marketCommitment!=="confirmed" ||
      !Number.isSafeInteger(quote.marketContextSlot) || quote.marketContextSlot<slot) return "confirmed_state_unavailable";
  return null;
}
