export function intervalRecoveries(events,startMs,endMs,targetNames) {
  const result={};
  for(const channel of ["primary","fallback"]) {
    const close=events.filter(e=>e.event==="websocket_closed"&&e.websocketSource===channel&&
      e.atMs>=startMs-3000&&e.atMs<=endMs).at(-1);
    result[channel]={};
    for(const target of targetNames) {
      const ack=close&&events.find(e=>e.event==="subscribed"&&e.websocketSource===channel&&
        e.sourceName===target&&e.atMs>=Math.max(startMs,close.atMs)&&e.atMs<=endMs);
      result[channel][target]=ack?{at:ack.at,afterCloseMs:ack.atMs-close.atMs}:null;
    }
  }
  return result;
}
