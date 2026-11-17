import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type Job, type JobResult, lintJob } from "./job.ts";

const FLAG = "optilint-worker";

// The worker runs this same module (in the Node bundle, the whole CLI, whose main() checks isMainThread).
// Bun once emitted this module twice in the bundle, and two handlers ran every job twice: register once.
const g = globalThis as { optilintWorker?: true };
if (!isMainThread && workerData === FLAG && !g.optilintWorker) {
  g.optilintWorker = true;
  parentPort!.on("message", (job: Job) => parentPort!.postMessage(lintJob(job)));
}

/** Worker threads for lint jobs. */
export class LintPool {
  private readonly workers: Worker[];

  constructor(size: number) {
    this.workers = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: FLAG }));
  }

  /** Runs `jobs`, largest first; results keep the order of `jobs`. */
  async run(jobs: readonly Job[]): Promise<JobResult[]> {
    const out = new Array<JobResult>(jobs.length);
    const order = jobs.map((_, i) => i).sort((a, b) => jobs[b]!.files.length - jobs[a]!.files.length);
    let next = 0;
    await Promise.all(this.workers.slice(0, jobs.length).map((w) => new Promise<void>((resolve, reject) => {
      let busy = false;
      w.on("error", reject);
      w.on("exit", (code) => busy && reject(new Error(`lint worker exited with code ${code}`)));
      const feed = () => {
        if (next >= order.length) return resolve();
        const i = order[next++]!;
        busy = true;
        w.once("message", (r: JobResult) => {
          busy = false;
          out[i] = r;
          feed();
        });
        w.postMessage(jobs[i]);
      };
      feed();
    })));
    return out;
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
