import fs from "node:fs";
import { launchSignals } from "../../src/launch-follow.js";
const fixture=JSON.parse(fs.readFileSync(new URL("./launch-follow.json",import.meta.url)));
const price=launchSignals(fixture,fixture.slot,Date.now())[0].averagePriceSol;
export async function quote(side,mint,amount,options) {
  await new Promise(r=>setTimeout(r,5));
  return {...(side==="BUY"?{expectedTokenOutRaw:String(Math.floor(.005/price*1e6)),tokenDecimals:6}:{expectedSolOutRaw:"6000000"}),
    marketContextSlot:options.minContextSlot+1,rpcMs:5,quoteMs:5,rpcCalls:1};
}
