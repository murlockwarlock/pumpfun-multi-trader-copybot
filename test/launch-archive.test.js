import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLaunchArchive,mergeLaunchArchive } from "../src/launch-follow-archive.js";
import { LaunchFollow } from "../src/launch-follow.js";

test("committed archive survives duplicate snapshot and restart; archived mint never re-enters",async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"launch-archive-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,"archive.sqlite");
  const state={launches:{mint:{mint:"mint",status:"SKIP",observedAtMs:1,exits:{}},open:{status:"OPEN",observedAtMs:1,exits:{}}},sells:{},
    observation:{gaps:[{reason:"ws_unavailable",startMs:1,endMs:2}],ws:{old:1},confirmed:{},catalog:{},lastHeartbeatAtMs:10}};
  const original=structuredClone(state);
  let archive=openLaunchArchive(file);
  assert.equal(archive.compact(state,100,{retentionMs:50}),3);
  assert.ok(state.launches.open);assert.equal(state.launches.mint,undefined);
  archive.close();
  assert.equal(Object.keys(mergeLaunchArchive(original,file).launches).length,2);
  assert.equal(mergeLaunchArchive(state,file).observation.ws.old,1);
  archive=openLaunchArchive(file);
  try{
    const engine=new LaunchFollow({state,archived:m=>archive.has("launch",m),quote(){throw Error("duplicate quote");},save(){},emit(){}});
    await engine.launch({mint:"mint"});
    assert.equal(engine.state.launches.mint,undefined);
  } finally { archive.close(); }
});
