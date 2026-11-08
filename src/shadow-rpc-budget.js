// Independent, fail-fast budget: no waiting queue or retry storm can spill
// into execution. A per-request gate also bounds SDK fan-out, not just quotes.
export function readOnlyBudgetFetch({ request = fetch, now = Date.now, perSecond = 8, perMinute = 120 } = {}) {
  const calls = [];
  let coolUntil = 0;
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const methods = (Array.isArray(body) ? body : [body]).map(x => x.method);
    if (methods.some(m => !["getAccountInfo", "getMultipleAccounts", "getEpochInfo", "getMinimumBalanceForRentExemption"].includes(m))) throw Error("shadow_rpc_write_or_unapproved_method");
    const time = now();
    while (calls.length && calls[0] <= time - 60000) calls.shift();
    if (time < coolUntil || calls.length + methods.length > perMinute || calls.filter(t => t > time - 1000).length + methods.length > perSecond) throw Error("shadow_rpc_budget");
    calls.push(...methods.map(() => time));
    const response = await request(url, options);
    if (response.status === 429) { coolUntil = now() + 30000; throw Error("shadow_rpc_429_cooldown"); }
    return response;
  };
}
