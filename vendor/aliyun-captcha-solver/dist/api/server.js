import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { solve } from '../solver.js';
import { SolveJobQueue } from './job-queue.js';
import { normalizeSolveRequest } from './request.js';
const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 18787;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_JOB_RETENTION_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
function jsonResponse(response, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
    });
    response.end(body);
}
function errorResponse(response, statusCode, message, code = 'bad_request', details) {
    const error = { message, code, details };
    jsonResponse(response, statusCode, { error });
}
async function readJsonBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BODY_BYTES) {
            throw new Error(`Request body is larger than ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        return {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
}
function publicJob(job) {
    return {
        id: job.id,
        status: job.status,
        browser: job.request.browser,
        browserKey: job.request.browserKey,
        targetUrl: job.request.targetUrl,
        captchaOpenMode: job.request.captchaOpenMode,
        maxRetries: job.request.maxRetries,
        debugScreenshots: job.request.debugScreenshots,
        debugDir: job.request.debugDir,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        result: job.result,
        error: job.error,
    };
}
function toApiSolveResult(result) {
    return {
        success: result.success,
        attempts: result.attempts,
        targetX: result.targetX,
        confidence: result.confidence,
        captchaVerifyParam: result.captchaVerifyParam,
        debugDir: result.debugDir,
        error: result.error,
    };
}
function readPositiveIntegerEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
export function createApiServer() {
    const maxConcurrentJobs = readPositiveIntegerEnv('API_MAX_CONCURRENT_JOBS', DEFAULT_MAX_CONCURRENT_JOBS);
    const retentionMs = readPositiveIntegerEnv('API_JOB_RETENTION_MS', DEFAULT_JOB_RETENTION_MS);
    const queue = new SolveJobQueue(async (job) => {
        const request = job.request;
        const debugDir = request.debugDir || (request.debugScreenshots === true ? path.join('artifacts', 'api', job.id) : undefined);
        const result = await solve({
            host: request.browser.host,
            port: request.browser.port,
            targetUrl: request.targetUrl,
            captchaOpenMode: request.captchaOpenMode,
            maxRetries: request.maxRetries,
            waitForPuzzleTimeout: request.waitForPuzzleTimeout,
            verbose: request.verbose,
            debugScreenshots: request.debugScreenshots,
            debugDir,
            gestureProfile: request.gestureProfile,
            targetOffset: request.targetOffset,
            targetBias: request.targetBias,
            reuseOpenCaptcha: request.reuseOpenCaptcha,
            captureFullDragTrace: request.captureFullDragTrace,
        });
        return toApiSolveResult(result);
    }, { maxConcurrentJobs, retentionMs });
    const server = http.createServer(async (request, response) => {
        try {
            if (request.method === 'OPTIONS') {
                jsonResponse(response, 204, {});
                return;
            }
            const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
            if (request.method === 'GET' && url.pathname === '/health') {
                jsonResponse(response, 200, {
                    ok: true,
                    service: 'aliyun-captcha-solver-api',
                    stats: queue.stats(),
                });
                return;
            }
            if (request.method === 'POST' && url.pathname === '/solve') {
                const body = await readJsonBody(request);
                const normalized = normalizeSolveRequest(body);
                const job = queue.enqueue(normalized);
                jsonResponse(response, 202, {
                    jobId: job.id,
                    status: job.status,
                    browser: job.request.browser,
                    browserKey: job.request.browserKey,
                    captchaOpenMode: job.request.captchaOpenMode,
                    createdAt: job.createdAt,
                    pollUrl: `/jobs/${job.id}`,
                });
                return;
            }
            const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
            if (request.method === 'GET' && jobMatch) {
                const job = queue.get(jobMatch[1]);
                if (!job) {
                    errorResponse(response, 404, 'Job not found', 'job_not_found');
                    return;
                }
                jsonResponse(response, 200, publicJob(job));
                return;
            }
            errorResponse(response, 404, 'Route not found', 'route_not_found');
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                errorResponse(response, 400, 'Invalid JSON body', 'invalid_json', error.message);
                return;
            }
            errorResponse(response, 400, error instanceof Error ? error.message : String(error));
        }
    });
    return { server, queue };
}
export function startApiServer() {
    const host = process.env.API_HOST || DEFAULT_API_HOST;
    const port = readPositiveIntegerEnv('API_PORT', DEFAULT_API_PORT);
    if (port > 65535) {
        throw new Error('API_PORT must be between 1 and 65535');
    }
    const { server } = createApiServer();
    server.on('error', (error) => {
        console.error(`[api] Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
    server.listen(port, host, () => {
        console.log(`[api] Aliyun CAPTCHA solver API listening on http://${host}:${port}`);
        console.log('[api] POST /solve, GET /jobs/:id, GET /health');
    });
}
const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
    startApiServer();
}
//# sourceMappingURL=server.js.map
