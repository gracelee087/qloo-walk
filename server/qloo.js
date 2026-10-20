// Qloo through the hackathon kit's `qloo api` CLI (a supported surface; the raw
// API shape keeps each place's lat/lon, which the workflow tools drop).
// The kit excludes the legacy `qloo api mcp` server, so each uncached request
// runs one CLI process (measured 5.8–8.5 s on Windows).
// Needs QLOO_API_KEY, and QLOO_HOME whose config has
// base-url = https://hackathon.api.qloo.com (see Dockerfile).
// Responses stay in memory only — Qloo data must not reach the public repo.
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";

const TIMEOUT = 30000;
const MAX_RUNNING = 3;            // CLI processes at once; the rest wait their turn
const cache = new Map();          // args -> Promise of parsed result (this process only)
let running = 0;
const queue = [];
async function slot() {
  if (running >= MAX_RUNNING) await new Promise((r) => queue.push(r));
  running++;
}
function release() { running--; queue.shift()?.(); }

// [command, leading args]. Windows' qloo.cmd can't be run without a shell, and a
// shell would re-parse user text, so run the harness entry with node instead.
function qlooCommand() {
  if (process.env.QLOO_BIN) return [process.execPath, [process.env.QLOO_BIN]];
  if (process.platform !== "win32") return ["qloo", []];
  const root = execFileSync("npm", ["root", "-g"], { shell: true, encoding: "utf8" }).trim();
  return [process.execPath, [join(root, "@qloo", "qloo-harness", "dist", "bin.js")]];
}
let command = null;

async function run(argv) {
  command ||= qlooCommand();
  const [cmd, lead] = command;
  await slot();
  try {
    return await new Promise((resolve, reject) => {
      execFile(cmd, [...lead, ...argv], { env: process.env, timeout: TIMEOUT, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const why = err.killed ? `timeout after ${TIMEOUT / 1000} s` : `exit ${err.code}`;
            return reject(new Error(`${argv[1]}: ${why} ${(stderr || stdout).trim().slice(0, 200)}`));
          }
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error("qloo: bad JSON")); }
        });
    });
  } finally { release(); }
}

// `qloo api <args…> --json` -> parsed Qloo response; failures are not cached
export function qloo(args) {
  const key = JSON.stringify(args);
  if (!cache.has(key)) cache.set(key, run(["api", ...args, "--json"]).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

// `qloo exec <tool> --input <json>` (prints JSON without --json) -> parsed result; cached the same way
export function qlooExec(tool, input) {
  const key = JSON.stringify(["exec", tool, input]);
  if (!cache.has(key)) cache.set(key, run(["exec", tool, "--input", JSON.stringify(input)]).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}
