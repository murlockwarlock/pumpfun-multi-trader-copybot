export function assessTargetHealth(targets, maxRpcSilenceMs, now = Date.now()) {
  const targetHealth = targets.map((target) => ({
    name: target.name,
    wallet: target.wallet,
    liveEnabled: target.liveEnabled,
    rpcSilenceMs: now - target.lastSuccessfulPollAt,
    lastWsMessageAt: target.lastWsMessageAt
      ? new Date(target.lastWsMessageAt).toISOString() : null,
    cursor: target.ingestion.cursor
  }));
  const staleTargets = targetHealth.filter(
    (target) => target.rpcSilenceMs > maxRpcSilenceMs
  );
  return {
    targetHealth,
    staleTargets,
    allTargetsStale: staleTargets.length === targetHealth.length,
    // This is the age of the freshest successful HTTP poll. A single poisoned
    // wallet must not make the whole process look disconnected from RPC.
    rpcSilenceMs: Math.min(...targetHealth.map((target) => target.rpcSilenceMs))
  };
}
