#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
function parseFlags() {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('--'))
            continue;
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        }
        else {
            flags[key] = true;
        }
    }
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    return {
        attempts: parseInt(String(flags.attempts || '3'), 10),
        waitMs: parseInt(String(flags['wait-ms'] || '120000'), 10),
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || path.join('manual-handoffs', `batch-${runId}`))),
        host: String(flags.host || '127.0.0.1'),
        port: parseInt(String(flags.port || '9222'), 10),
        targetUrl: String(flags['target-url'] || '/auth?response_type=code'),
        verbose: !flags.quiet,
        reload: !flags['no-reload'],
    };
}
function log(verbose, ...args) {
    if (verbose)
        console.log('[manual-handoff-batch]', ...args);
}
function attemptDirName(attempt) {
    return `attempt-${String(attempt).padStart(2, '0')}`;
}
async function readJson(filePath) {
    try {
        const text = await readFile(filePath, 'utf8');
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
async function runSingleAttempt(flags, attempt) {
    const attemptDir = path.join(flags.rootDir, attemptDirName(attempt));
    await mkdir(attemptDir, { recursive: true });
    const commandArgs = [
        'tsx',
        'src/manual-handoff.ts',
        '--host', flags.host,
        '--port', String(flags.port),
        '--target-url', flags.targetUrl,
        '--wait-ms', String(flags.waitMs),
        '--root-dir', attemptDir,
    ];
    if (!flags.reload) {
        commandArgs.push('--no-reload');
    }
    await new Promise((resolve, reject) => {
        const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
        const child = spawn(process.execPath, [tsxCli, ...commandArgs.slice(1)], {
            cwd: process.cwd(),
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`manual-handoff attempt ${attempt} exited with code ${code}`));
        });
        child.on('error', reject);
    });
    const summary = await readJson(path.join(attemptDir, 'summary.json'));
    return {
        attempt,
        attemptDir,
        finishedAt: summary?.finishedAt,
        outcome: summary?.outcome || null,
        success: !!summary?.success,
        verifyCode: summary?.verifyCode || null,
        observedReleaseCount: summary?.observedReleaseCount ?? null,
        error: null,
    };
}
async function main() {
    const flags = parseFlags();
    await mkdir(flags.rootDir, { recursive: true });
    console.log('=== Manual Handoff Batch ===');
    console.log(`Attempts: ${flags.attempts}`);
    console.log(`Wait: ${flags.waitMs}ms`);
    console.log(`Target: ${flags.targetUrl}`);
    console.log(`Output: ${flags.rootDir}`);
    console.log('');
    const attempts = [];
    for (let attempt = 1; attempt <= flags.attempts; attempt++) {
        log(flags.verbose, `Starting attempt ${attempt}/${flags.attempts}`);
        try {
            attempts.push(await runSingleAttempt(flags, attempt));
        }
        catch (err) {
            attempts.push({
                attempt,
                attemptDir: path.join(flags.rootDir, attemptDirName(attempt)),
                outcome: null,
                success: false,
                verifyCode: null,
                observedReleaseCount: null,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    const summary = {
        finishedAt: new Date().toISOString(),
        options: flags,
        attempts,
        stats: {
            totalAttempts: attempts.length,
            successCount: attempts.filter((attempt) => attempt.success).length,
            releaseObservedCount: attempts.filter((attempt) => Number(attempt.observedReleaseCount || 0) > 0).length,
            outcomeCounts: attempts.reduce((acc, attempt) => {
                const key = attempt.outcome || 'n/a';
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {}),
        },
    };
    await writeFile(path.join(flags.rootDir, 'batch-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(`Batch finished. Attempts: ${attempts.length}`);
    console.log(`Release observed: ${summary.stats.releaseObservedCount}/${attempts.length}`);
    console.log(`Saved batch summary: ${path.join(flags.rootDir, 'batch-summary.json')}`);
}
await main();
//# sourceMappingURL=manual-handoff-batch.js.map