import { readOnlyBudgetFetch } from "../../src/shadow-rpc-budget.js";
const rpc=readOnlyBudgetFetch({request:async()=>new Response("",{status:429})});
export const rpcStats=rpc.stats;
export async function quote(){return rpc("https://fixture.invalid",{body:JSON.stringify({method:"getAccountInfo"})});}
