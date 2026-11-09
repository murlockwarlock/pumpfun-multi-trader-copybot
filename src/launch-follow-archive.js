import { DatabaseSync } from "node:sqlite";

export function openLaunchArchive(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archive (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id))");
  const write = db.prepare("INSERT OR REPLACE INTO archive VALUES (?, ?, ?)");
  const exists = db.prepare("SELECT 1 FROM archive WHERE kind=? AND id=?");
  return {
    has: (kind, id) => Boolean(exists.get(kind, id)),
    compact(state, now, { retentionMs = 7_200_000, maxRows = 8192 } = {}) {
      const cutoff = now - retentionMs;
      const observation = state.observation;
      const remove = [];
      function move(kind, id, body, prune) {
        write.run(kind, id, JSON.stringify(body));
        remove.push(prune);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const launches=Object.entries(state.launches);
        for (const [index, [mint, launch]] of launches.entries()) {
          if (["PREPARING", "OPEN"].includes(launch.status)) continue;
          if (launch.epochId === state.epoch?.id && launch.observedAtMs >= cutoff && index>=launches.length-512) continue;
          move("launch", mint, { launch, sells: state.sells[mint] ?? [] }, () => {
            delete state.launches[mint];
            delete state.sells[mint];
          });
        }
        for (const kind of ["ws", "confirmed", "catalog", "sells"]) {
          const map = kind === "sells" ? state.sells : observation[kind] ?? {};
          const rows = Object.entries(map);
          for (const [index, [id, value]] of rows.entries()) {
            if (kind === "sells" && state.launches[id]) continue;
            const at = typeof value === "number" ? value : Array.isArray(value) ? value.at(-1)?.observedAtMs : value.atMs;
            if (at >= cutoff && index >= rows.length-maxRows) continue;
            move(kind, id, value, () => { delete map[id]; });
          }
        }
        for (const gap of observation.gaps) {
          if (gap.endMs === null || gap.endMs >= cutoff) continue;
          const id = JSON.stringify([gap.reason,gap.startMs,gap.endMs]);
          move("gap", id, gap, () => { observation.gaps = observation.gaps.filter(g => g !== gap); });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // A crash before the snapshot replacement can leave a second copy.
      // The archive is keyed and reports prefer the more recent snapshot.
      for (const prune of remove) prune();
      return remove.length;
    },
    close: () => db.close()
  };
}

export function mergeLaunchArchive(state, file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const archived = { launches:{}, sells:{}, observation:{ws:{},confirmed:{},catalog:{},gaps:[]} };
    for (const {kind,id,body} of db.prepare("SELECT kind,id,body FROM archive").iterate()) {
      const value = JSON.parse(body);
      if (kind === "launch") {
        archived.launches[id] = value.launch;
        archived.sells[id] = value.sells;
      } else if (kind === "sells") archived.sells[id] = value;
      else if (kind === "gap") archived.observation.gaps.push(value);
      else archived.observation[kind][id] = value;
    }
    const observation = {...archived.observation,...state.observation};
    for (const kind of ["ws","confirmed","catalog"]) {
      observation[kind] = {...archived.observation[kind],...state.observation?.[kind]};
    }
    observation.gaps = [...new Map([...archived.observation.gaps,...(state.observation?.gaps??[])]
      .map(g=>[JSON.stringify([g.reason,g.startMs,g.endMs]),g])).values()];
    return {...state,observation,launches:{...archived.launches,...state.launches},sells:{...archived.sells,...state.sells}};
  } finally { db.close(); }
}
