import { parentPort, workerData } from "node:worker_threads";
import { buildLiveReport, buildShadowReport } from "./live-report.js";

const { day, liveFile, shadowFile, positions, shadow } = workerData;
parentPort.postMessage({
  report: buildLiveReport(liveFile, day, positions),
  shadowReport: shadow ? buildShadowReport(shadowFile, day, shadow) : null
});
