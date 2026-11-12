// Independent, fail-fast budget: no waiting queue or retry storm can spill
// into execution. A per-request gate also bounds SDK fan-out, not just quotes.
export function readOnlyBudgetFetch({ request = fetch, now = Date.now, perSecond = 8, perMinute = 120 } = {}) {
  const calls = [];
  const latencyMs=[];
  const stats={requests:0,errors:0,rateLimited:0,budgetRejected:0,totalMs:0,methods:{}};
  let coolUntil = 0;
  const guarded = async (url, options) => {
    const body = JSON.parse(options.body);
    const methods = (Array.isArray(body) ? body : [body]).map(x => x.method);
    if (methods.some(m => !["getAccountInfo", "getMultipleAccounts", "getEpochInfo", "getMinimumBalanceForRentExemption"].includes(m))) throw Error("shadow_rpc_write_or_unapproved_method");
    const time = now();
    while (calls.length && calls[0] <= time - 60000) calls.shift();
    if (time < coolUntil || calls.length + methods.length > perMinute || calls.filter(t => t > time - 1000).length + methods.length > perSecond) { stats.budgetRejected++; throw Error("shadow_rpc_budget"); }
    calls.push(...methods.map(() => time));
    stats.requests+=methods.length;
    for (const m of methods) stats.methods[m]=(stats.methods[m]??0)+1;
    try {
      const response = await request(url, options);
      if (response.status === 429) { stats.rateLimited++; coolUntil = now() + 30000; throw Error("shadow_rpc_429_cooldown"); }
      if (!response.ok && response.ok!==undefined) stats.errors++;
      if (response.ok && response.clone) { const j=await response.clone().json(); if(j.error) stats.errors++; }
      return response;
    } catch(e) { stats.errors++; throw e; }
    finally {
      const elapsed=now()-time;
      stats.totalMs+=elapsed;
      latencyMs.push(elapsed);
      if(latencyMs.length>256)latencyMs.shift();
    }
  };
  guarded.stats=()=>structuredClone({...stats,latencyMs});
  return guarded;
}
