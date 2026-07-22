/**
 * Client for the GLM-style Aliyun puzzle captcha solver API (CDP).
 *
 * GLM flow (working):
 *  1. Launch browser with --remote-debugging-port
 *  2. Fill form / open captcha widget
 *  3. POST /solve { browser:{host,port}, captchaOpenMode:'open_if_needed', gestureProfile:'monotonic_soft' }
 *  4. Poll /jobs/:id until succeeded
 *
 * IMPORTANT: captcha_only does NOT click "Click to start verification" and fails
 * if the puzzle window is not already open. Always prefer open_if_needed for Qwen.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CaptchaApiSolveResult {
  ok: boolean;
  attempts?: number;
  confidence?: number;
  targetX?: number;
  error?: string;
  source: "api" | "unavailable";
}

let activeApiBase =
  String(config.accountCreator.captchaApiUrl || "http://127.0.0.1:18787")
    .trim()
    .replace(/\/+$/, "") || "http://127.0.0.1:18787";
let apiStartPromise: Promise<void> | null = null;
let startedChild: ChildProcess | null = null;

function apiUrl(pathname: string, base = activeApiBase): string {
  return new URL(pathname, `${base}/`).toString();
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, data };
}

function isHealthy(data: any): boolean {
  return data?.ok === true && data?.service === "aliyun-captcha-solver-api";
}

async function waitHealth(
  baseURL: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetchJson(apiUrl("/health", baseURL));
      if (r.ok && isHealthy(r.data)) return true;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return false;
}

function candidateWorkdirs(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw?: string) => {
    const value = String(raw || "").trim();
    if (!value) return;
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  push(config.accountCreator.captchaApiWorkdir);
  for (const extra of config.accountCreator.captchaApiFallbackWorkdirs) {
    push(extra);
  }

  // Default: sibling glm5.2proxy embedded solver + local vendor + glm runtime copy
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  push(path.join(repoRoot, "vendor", "aliyun-captcha-solver"));
  push(
    path.resolve(
      repoRoot,
      "..",
      "glm5.2proxy",
      "internal",
      "automation",
      "assets",
      "aliyun-captcha-solver",
    ),
  );
  push(
    path.join(
      home,
      "Documents",
      "GitHub",
      "glm5.2proxy",
      "internal",
      "automation",
      "assets",
      "aliyun-captcha-solver",
    ),
  );
  // Runtime copy used by glm5.2proxy when it embeds the solver
  push(path.join(home, ".glm5.2proxy", "embedded-automation", "aliyun-captcha-solver"));
  return out;
}

async function reservePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not reserve captcha API port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function launchSpec(workDir: string): { command: string; args: string[]; label: string } | null {
  if (fs.existsSync(path.join(workDir, "server.js"))) {
    return {
      command: process.execPath,
      args: ["server.js"],
      label: "node server.js",
    };
  }
  if (fs.existsSync(path.join(workDir, "dist", "api", "server.js"))) {
    return {
      command: process.execPath,
      args: ["-e", "import('./dist/api/server.js').then(m=>m.startApiServer())"],
      label: "node dist/api/server.js",
    };
  }
  return null;
}

async function startLocalApi(): Promise<void> {
  const errors: string[] = [];
  for (const workDir of candidateWorkdirs()) {
    if (!fs.existsSync(workDir)) {
      errors.push(`${workDir}: missing`);
      continue;
    }
    const spec = launchSpec(workDir);
    if (!spec) {
      errors.push(`${workDir}: no server.js`);
      continue;
    }
    try {
      const port = await reservePort("127.0.0.1");
      const baseURL = `http://127.0.0.1:${port}`;
      console.log(
        `🧩 [CaptchaAPI] starting local solver | cwd=${workDir} | ${spec.label} | ${baseURL}`,
      );
      const child = spawn(spec.command, spec.args, {
        cwd: workDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          API_HOST: "127.0.0.1",
          API_PORT: String(port),
          PORT: String(port),
        },
      });
      child.unref();
      startedChild = child;
      const ok = await waitHealth(baseURL, config.accountCreator.captchaApiStartTimeoutMs);
      if (!ok) {
        errors.push(`${workDir}: health timeout`);
        continue;
      }
      activeApiBase = baseURL;
      console.log(`✅ [CaptchaAPI] ready | ${baseURL}`);
      return;
    } catch (err) {
      errors.push(
        `${workDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error(
    `Não subiu a Captcha API local. Tentativas: ${errors.join(" | ")}`,
  );
}

export async function ensureCaptchaApi(): Promise<boolean> {
  if (!config.accountCreator.captchaApiEnabled) return false;
  try {
    if (await waitHealth(activeApiBase, 1_200)) return true;
  } catch {
    // fall through
  }
  if (!apiStartPromise) {
    apiStartPromise = startLocalApi()
      .catch((err) => {
        apiStartPromise = null;
        throw err;
      })
      .then(() => undefined);
  }
  try {
    await apiStartPromise;
    return true;
  } catch (err) {
    console.warn(
      `⚠️  [CaptchaAPI] indisponível: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function solveCaptchaViaApi(options: {
  cdpHost?: string;
  cdpPort: number;
  targetUrl?: string;
  retries?: number;
  gestureProfile?: string;
  timeoutMs?: number;
}): Promise<CaptchaApiSolveResult> {
  const ready = await ensureCaptchaApi();
  if (!ready) {
    return {
      ok: false,
      source: "unavailable",
      error: "Captcha API offline",
    };
  }

  const body = {
    browser: {
      host: options.cdpHost || "127.0.0.1",
      port: options.cdpPort,
    },
    // Qwen often shows only the entry button first. open_if_needed makes the
    // solver click "Click to start verification" and wait for the puzzle window.
    // captcha_only FAILS with: Puzzle did not become ready... Click "Click to start verification" first
    captchaOpenMode: "open_if_needed",
    targetUrl: options.targetUrl || "chat.qwen.ai",
    retries: options.retries ?? config.accountCreator.captchaRetries,
    gestureProfile:
      options.gestureProfile || config.accountCreator.captchaGesture,
    reuseOpenCaptcha: true,
    openIfNeeded: true,
    waitForReadyMs: 12_000,
    waitForPuzzleTimeoutMs: 12_000,
    verbose: false,
    debugScreenshots: false,
  };

  console.log(
    `🧩 [CaptchaAPI] POST /solve | cdp=${body.browser.host}:${body.browser.port} | gesture=${body.gestureProfile}`,
  );

  const created = await fetchJson(apiUrl("/solve"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!created.ok || !created.data?.jobId) {
    return {
      ok: false,
      source: "api",
      error: `POST /solve falhou: ${created.data?.error?.message || created.status}`,
    };
  }

  const jobId = String(created.data.jobId);
  const timeoutMs = options.timeoutMs ?? config.accountCreator.captchaJobTimeoutMs;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await fetchJson(apiUrl(`/jobs/${jobId}`));
    const status = job.data?.status;
    if (status === "succeeded") {
      console.log(
        `✅ [CaptchaAPI] solved | attempts=${job.data?.result?.attempts} conf=${job.data?.result?.confidence}`,
      );
      return {
        ok: true,
        source: "api",
        attempts: job.data?.result?.attempts,
        confidence: job.data?.result?.confidence,
        targetX: job.data?.result?.targetX,
      };
    }
    if (status === "failed") {
      return {
        ok: false,
        source: "api",
        error: job.data?.result?.error || "captcha failed",
      };
    }
    if (status === "error") {
      return {
        ok: false,
        source: "api",
        error: job.data?.error?.message || "captcha infra error",
      };
    }
    await sleep(400);
  }
  return {
    ok: false,
    source: "api",
    error: `Timeout aguardando job ${jobId}`,
  };
}

/** Free a local TCP port for Chrome remote debugging. */
export async function reserveCdpPort(): Promise<number> {
  return reservePort("127.0.0.1");
}
