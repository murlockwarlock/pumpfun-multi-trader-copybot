const MARKET_INVOKE=/^Program (?:pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA|6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) invoke \[/;

// Flush on the existing 20-second heartbeat. Accepted frames already have
// a SIGNAL record; keep a small signature sample only for filtered frames.
export function wsDiagnostics(limit=8) {
  let wallets=new Map(),unmatched=0;
  return {
    receive(wallet) {
      if (!wallet) {unmatched++;return;}
      let row=wallets.get(wallet);
      if (!row) {
        row={received:0,filtered:{},samples:[],omitted:0};
        wallets.set(wallet,row);
      }
      row.received++;
      return (reason,value,slot)=>{
        row.filtered[reason]=(row.filtered[reason]??0)+1;
        if (reason==="duplicate"||typeof value?.signature!=="string"||
            !Array.isArray(value.logs)||!value.logs.some(line=>MARKET_INVOKE.test(line))) return;
        if (row.samples.length>=limit) {row.omitted++;return;}
        row.samples.push({reason,signature:value.signature,slot:slot??null,
          logCount:value.logs.length,truncated:value.logs.includes("Log truncated")});
      };
    },
    flush() {
      const result={wallets:Object.fromEntries(wallets),unmatched};
      wallets=new Map();
      unmatched=0;
      return result;
    }
  };
}
