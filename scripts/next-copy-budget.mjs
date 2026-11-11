import { AsyncLocalStorage } from "node:async_hooks";

// Reserve an SDK quote as a unit. Actual calls replace reservations, and
// unused calls return immediately. History and in-flight capacity both count.
export function observerBudget({wallets, limit, unit, phaseReserves, maxActive=Infinity, now=Date.now}) {
  const context = new AsyncLocalStorage();
  const history = [];
  const active = new Set();
  function reserve(wallet, phase) {
    if (active.size>=maxActive) throw Error("observer_rpc_budget_active_quote");
    const time=now();
    while (history.length && history[0].at<=time-60000) history.shift();
    const occupied=[...history,...active].filter(r=>r.cost>0);
    const used=occupied.reduce((n,r)=>n+r.cost,0);
    const next=[...occupied,{wallet,phase,cost:unit}];
    const capacity=(key,value)=>next.filter(r=>r[key]===value).reduce((n,r)=>n+r.cost,0);
    const otherWallets=wallets.filter(w=>w!==wallet).reduce((n,w)=>
      n+Math.max(0,unit-capacity("wallet",w)),0);
    const otherPhases=Object.entries(phaseReserves).filter(([p])=>p!==phase).reduce((n,[p,r])=>
      n+Math.max(0,r-capacity("phase",p)),0);
    if (used+unit>limit) throw Error("observer_rpc_budget_total");
    if (used+unit+Math.max(otherWallets,otherPhases)>limit) throw Error("observer_rpc_budget_reserved");
    const lease={wallet,phase,cost:unit};
    active.add(lease);
    return lease;
  }
  return {
    async run(wallet,phase,fn) {
      const lease=reserve(wallet,phase);
      try { return await context.run(lease,fn); }
      finally { active.delete(lease); }
    },
    consume(cost=1) {
      const lease=context.getStore();
      if (!lease || !active.has(lease) || lease.cost<cost) throw Error("observer_rpc_budget_quote_fanout");
      lease.cost-=cost;
      history.push({wallet:lease.wallet,phase:lease.phase,cost,at:now()});
    }
  };
}
