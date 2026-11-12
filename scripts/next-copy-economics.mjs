export const CONTROL_INPUT = 5_000_000n;
export const FIXED_FEE = 110_000n;
export const SLIPPAGE_BPS = 100;
const BPS = 10_000n;
const AFTER_SLIPPAGE = BPS - BigInt(SLIPPAGE_BPS);

export function parseSizeSol(value) {
  if (!/^\d+(?:\.\d{1,9})?$/.test(value)) throw Error("Size must be a decimal SOL amount with at most 9 fractional digits");
  const [whole,fraction=""] = value.split(".");
  const amount=BigInt(whole)*1_000_000_000n+BigInt(fraction.padEnd(9,"0"));
  if (amount<=0n || amount>BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Size is outside the supported lamport range");
  return amount;
}

export const runInput = start => BigInt(start?.inputLamports ?? CONTROL_INPUT);
export const discount = amount => amount*AFTER_SLIPPAGE/BPS;

export function modelNet(quote, input=CONTROL_INPUT, rent=0n) {
  return discount(BigInt(quote.expectedSolOutRaw))-input-3n*FIXED_FEE-rent;
}

export function breakEven(input,rent=0n) {
  const minOut=input+3n*FIXED_FEE+rent;
  const sellQuote=(minOut*BPS+AFTER_SLIPPAGE-1n)/AFTER_SLIPPAGE;
  return {minOut,sellQuote};
}

export function sameSizePair(buy,sell,input) {
  if (input!==CONTROL_INPUT && (buy.inputLamports===undefined || sell.inputLamports===undefined)) return false;
  return BigInt(buy.inputLamports??CONTROL_INPUT)===input && BigInt(sell.inputLamports??CONTROL_INPUT)===input &&
    buy.quantityRaw===sell.quantityRaw;
}
