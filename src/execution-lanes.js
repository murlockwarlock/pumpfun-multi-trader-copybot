export class ExecutionLanes {
  tails = new Map();

  run(key, execute) {
    return this.runMany([key], execute);
  }

  runMany(keys, execute) {
    const task = Promise.all(keys.map(key => this.tails.get(key))).then(execute);
    const tail = task.then(cleanup, cleanup);
    for (const key of keys) this.tails.set(key, tail);
    const lanes = this.tails;
    function cleanup() {
      for (const key of keys) if (lanes.get(key) === tail) lanes.delete(key);
    }
    return task;
  }
}

export class ExecutionTimings {
  groups = new Map();

  add(record) {
    for (const group of [`trader/${record.sourceWallet ?? "manual"}`, `venue/${record.venue}`]) {
      const rows = this.groups.get(group) ?? [];
      rows.push(record);
      if (rows.length > 512) rows.shift();
      this.groups.set(group, rows);
    }
  }

  report() {
    const result = {};
    for (const [group, rows] of this.groups) {
      const metrics = {};
      for (const key of ["decodeMs","resolveMs","queueDelayMs","prepareMs","submitMs","signalToSubmitMs"]) {
        const values = rows.map(row => row[key]).filter(Number.isFinite).sort((a,b) => a-b);
        if (values.length) metrics[key] = Object.fromEntries([50,95,99].map(p =>
          [`p${p}`, values[Math.ceil(values.length*p/100)-1]]));
      }
      result[group] = metrics;
    }
    return result;
  }
}
