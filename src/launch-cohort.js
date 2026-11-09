export function compareLaunches(a,b) {
  return a.slot-b.slot || a.observedAtMs-b.observedAtMs || a.signature.localeCompare(b.signature) || a.mint.localeCompare(b.mint);
}

export function admitToCohort(cohort, launch) {
  const key={mint:launch.mint,signature:launch.signature,slot:launch.slot,observedAtMs:launch.observedAtMs};
  if (cohort.exploratory.some(p=>p.mint===key.mint)||cohort.holdout.some(p=>p.mint===key.mint)) return;
  const active=cohort.exploratory.length<25?cohort.exploratory:cohort.holdout;
  const boundary=cohort.holdout.length===25?cohort.holdout.at(-1):
    cohort.exploratory.length===25?cohort.exploratory.at(-1):null;
  if (boundary && compareLaunches(key,boundary)<0) {
    cohort.breaches=(cohort.breaches??0)+1;
    launch.cohortStatus="late_before_frozen_boundary";
    return;
  }
  if (active.length===25) return;
  active.push(key);
  active.sort(compareLaunches);
  launch.cohortStatus=active===cohort.exploratory?"exploratory":"holdout";
}
