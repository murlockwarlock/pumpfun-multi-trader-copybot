import test from "node:test";
import assert from "node:assert/strict";
import {breakEven,modelNet,parseSizeSol} from "../scripts/next-copy-economics.mjs";
import {freezeRate,sizeScenarios} from "../scripts/next-copy-size-study.mjs";
import {compareStudy,economics} from "../scripts/next-copy-size-compare.mjs";

test("SOL and USD input sizes use exact lamports and fixed cost breakeven",()=>{
  assert.equal(parseSizeSol("0.06"),60_000_000n);
  assert.throws(()=>parseSizeSol("0.0000000001"));
  assert.throws(()=>parseSizeSol("0"));
  assert.deepEqual(sizeScenarios("83.72").map(r=>r.inputLamports),
    ["5000000","59722885","119445771","238891543","358337314"]);
  for (const scenario of sizeScenarios("83.72")) {
    const input=BigInt(scenario.inputLamports),rent=1_513_840n;
    const q=breakEven(input,rent).sellQuote;
    assert.equal(modelNet({expectedSolOutRaw:q},input,rent),0n);
    assert.equal(modelNet({expectedSolOutRaw:q-1n},input,rent),-1n);
  }
});

test("SOL/USD source fails closed when stale",async()=>{
  const now=new Date().toISOString();
  const fresh=await freezeRate(async()=>new Response(JSON.stringify({price:"83.72",time:now})));
  assert.equal(fresh.tradeAt,now);
  assert.equal(fresh.usdPerSol,"83.72");
  assert.match(fresh.source,/SOL-USD\/ticker$/);
  await assert.rejects(freezeRate(async()=>new Response(JSON.stringify({price:"83.72",time:"2020-01-01T00:00:00Z"}))),/stale/);
});

test("size reports match five independent quotes by source, time and context",()=>{
  const wallet="sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT";
  const fx={source:"https://api.exchange.coinbase.com/products/SOL-USD/ticker",usdPerSol:"100",
    tradeAt:"2026-11-11T00:00:00Z",observedAt:"2026-11-11T00:00:01Z"};
  const suite={fx,wallets:[wallet],scenarios:sizeScenarios("100")};
  const journals=Object.fromEntries(suite.scenarios.map((s,i)=>{
    const run=s.id,inputLamports=s.inputLamports,quantityRaw=String(10000*(i+1));
    const b={wallet,signature:"sig",slot:8,quantityRaw,inputLamports,observedAt:100};
    const quote=(slot,at)=>({marketContextSlot:slot,marketContextMaxSlot:slot+1,startedAtMs:at,venue:"pumpswap"});
    return [s.id,[
      {type:"START",at:0,wallets:[wallet],inputLamports,study:{scenario:s.id,fx}},
      {type:"SIGNAL",at:100,wallet,signature:"sig",provisionalSides:["BUY"]},
      {...b,type:"ELIGIBLE",at:200,side:"BUY"},
      {...b,type:"BUY_QUOTE",at:500+i,quote:quote(9,250+i)},
      {...b,type:"FINALIZED",at:25000},
      {...b,type:"SELL_QUOTE",at:30500+i,kind:"30s",dueAt:30100,quote:quote(50,30105+i),
        netLamports:String(i*100-50),netIfRentNotRecoveredLamports:String(i*100-200)},
      {type:"STOP",at:45000}
    ].map(r=>({...r,run}))];
  }));
  const rows=()=>compareStudy(suite,journals).wallets[wallet].horizons["30s"];
  assert.deepEqual(rows().map(r=>r.matched.netLamports),["-50","50","150","250","350"]);
  const exit=journals.usd30.find(r=>r.type==="SELL_QUOTE");
  exit.quote.marketContextMaxSlot+=9;
  assert.deepEqual(rows().map(r=>r.matched.pairs),[0,0,0,0,0]);
  assert.equal(rows().at(-1).independent.pairs,1);
  exit.inputLamports="5000000";
  assert.equal(rows().at(-1).independent.pairs,0);
});

test("closed-sequence drawdown starts at zero and rent is a separate stress",()=>{
  const pairs=[-100,250,-80,-100].map((n,i)=>({signature:String(i),sellAt:i,netLamports:String(n),
    netWithoutRentRecoveryLamports:String(n-50)}));
  const result=economics(pairs,5000000n,"100");
  assert.equal(result.netLamports,"-30");
  assert.equal(result.withoutBestLamports,"-280");
  assert.equal(result.maxDrawdownLamports,"180");
  assert.equal(result.netWithoutRentRecoveryLamports,"-230");
  assert.equal(result.winRate,.25);
});
