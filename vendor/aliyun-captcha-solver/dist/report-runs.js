#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
function parseArgs() {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--'))
            continue;
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        }
        else {
            flags[key] = true;
        }
    }
    return {
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || 'isolated-runs')),
        output: flags.output ? path.resolve(process.cwd(), String(flags.output)) : null,
        limitRuns: Number(flags['limit-runs'] || 0) || null,
        auditJson: flags['audit-json'] ? path.resolve(process.cwd(), String(flags['audit-json'])) : null,
        onlyComparable: !!flags['only-comparable'],
        excludeRuns: String(flags['exclude-runs'] || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
    };
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
async function enrichAttemptRecord(attempt) {
    if (attempt.releasePositionErrorPx != null &&
        attempt.gestureProfile &&
        attempt.captchaFlow) {
        return attempt;
    }
    if (!attempt.attemptDir) {
        return attempt;
    }
    const summaryPath = path.join(attempt.attemptDir, 'summary.json');
    const detailed = await readJson(summaryPath);
    if (!detailed) {
        return attempt;
    }
    return {
        ...detailed,
        ...attempt,
        releasePositionErrorPx: attempt.releasePositionErrorPx != null
            ? attempt.releasePositionErrorPx
            : detailed.releasePositionErrorPx,
        gestureProfile: attempt.gestureProfile || detailed.gestureProfile,
        captchaFlow: attempt.captchaFlow || detailed.captchaFlow,
    };
}
function flattenAttempt(runName, run, attempt) {
    return {
        runName,
        finishedAt: run.finishedAt || null,
        attempt: Number(attempt.attempt || 0),
        success: !!attempt.success,
        verifyCode: attempt.verifyCode || 'n/a',
        confidence: typeof attempt.confidence === 'number' ? attempt.confidence : null,
        targetDisplayX: typeof attempt.targetDisplayX === 'number' ? attempt.targetDisplayX : null,
        releasePositionErrorPx: typeof attempt.releasePositionErrorPx === 'number' && Number.isFinite(attempt.releasePositionErrorPx)
            ? attempt.releasePositionErrorPx
            : null,
        gestureProfile: attempt.gestureProfile ||
            run.options?.gestureProfile ||
            null,
        postWaitMs: typeof run.options?.postWaitMs === 'number' ? run.options.postWaitMs : null,
        requestActions: Array.isArray(attempt.captchaFlow?.requestActions)
            ? attempt.captchaFlow.requestActions.map((entry) => String(entry?.action || 'n/a'))
            : [],
        responseCodes: Array.isArray(attempt.captchaFlow?.responseActions)
            ? attempt.captchaFlow.responseActions
                .map((entry) => String(entry?.code || (entry?.success === true ? 'success:true' : 'n/a')))
            : [],
    };
}
function summarizeAttempts(attempts) {
    const verifyCodeCounts = {};
    const errorValuesByCode = {};
    const profileCounts = {};
    let successCount = 0;
    for (const attempt of attempts) {
        if (attempt.success)
            successCount++;
        verifyCodeCounts[attempt.verifyCode] = (verifyCodeCounts[attempt.verifyCode] || 0) + 1;
        const profile = attempt.gestureProfile || 'n/a';
        profileCounts[profile] = (profileCounts[profile] || 0) + 1;
        if (attempt.releasePositionErrorPx != null) {
            (errorValuesByCode[attempt.verifyCode] ||= []).push(attempt.releasePositionErrorPx);
        }
    }
    const releaseErrorByCode = Object.fromEntries(Object.entries(errorValuesByCode).map(([code, values]) => {
        const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
        const absAvg = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
        return [code, {
                samples: values.length,
                avgPx: Number(avg.toFixed(3)),
                avgAbsPx: Number(absAvg.toFixed(3)),
                minPx: Number(Math.min(...values).toFixed(3)),
                maxPx: Number(Math.max(...values).toFixed(3)),
            }];
    }));
    return {
        totalAttempts: attempts.length,
        successCount,
        failureCount: attempts.length - successCount,
        successRate: attempts.length ? Number((successCount / attempts.length).toFixed(4)) : 0,
        verifyCodeCounts,
        profileCounts,
        releaseErrorByCode,
    };
}
function sortEntries(record) {
    return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
async function main() {
    const flags = parseArgs();
    const excludedRuns = new Set(flags.excludeRuns);
    const comparableAttemptKeys = new Set();
    const blockedAttemptKeys = new Set();
    if (flags.auditJson) {
        const audit = await readJson(flags.auditJson);
        for (const entry of audit?.attemptClassifications || []) {
            const runName = String(entry?.runName || '');
            const attemptName = String(entry?.attemptName || '');
            const classification = String(entry?.classification || '');
            if (!runName || !attemptName)
                continue;
            const key = `${runName}/${attemptName}`;
            if (classification === 'comparable') {
                comparableAttemptKeys.add(key);
            }
            else {
                blockedAttemptKeys.add(key);
            }
        }
        for (const entry of audit?.problematicAttempts || []) {
            const runName = String(entry?.runName || '');
            const attemptName = String(entry?.attemptName || '');
            if (runName && attemptName) {
                blockedAttemptKeys.add(`${runName}/${attemptName}`);
            }
        }
        if (flags.onlyComparable && comparableAttemptKeys.size === 0) {
            const dirents = await readdir(flags.rootDir, { withFileTypes: true });
            for (const runDirent of dirents) {
                if (!runDirent.isDirectory())
                    continue;
                const runName = runDirent.name;
                const runDir = path.join(flags.rootDir, runName);
                const attemptDirents = await readdir(runDir, { withFileTypes: true }).catch(() => []);
                for (const attemptDirent of attemptDirents) {
                    if (!attemptDirent.isDirectory() || !/^attempt-\d+$/i.test(attemptDirent.name))
                        continue;
                    const key = `${runName}/${attemptDirent.name}`;
                    if (!blockedAttemptKeys.has(key)) {
                        comparableAttemptKeys.add(key);
                    }
                }
            }
        }
    }
    const dirents = await readdir(flags.rootDir, { withFileTypes: true });
    let runNames = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !excludedRuns.has(name))
        .sort()
        .reverse();
    if (flags.limitRuns) {
        runNames = runNames.slice(0, flags.limitRuns);
    }
    const attempts = [];
    const perRun = [];
    for (const runName of runNames) {
        const summaryPath = path.join(flags.rootDir, runName, 'summary.json');
        const run = await readJson(summaryPath);
        if (!run || !Array.isArray(run.attempts))
            continue;
        perRun.push({ runName, stats: run.stats || null });
        for (const attempt of run.attempts) {
            const attemptName = `attempt-${String(attempt.attempt || 0).padStart(2, '0')}`;
            const attemptKey = `${runName}/${attemptName}`;
            if (flags.onlyComparable && comparableAttemptKeys.size > 0 && !comparableAttemptKeys.has(attemptKey)) {
                continue;
            }
            if (blockedAttemptKeys.has(attemptKey)) {
                continue;
            }
            const enriched = await enrichAttemptRecord(attempt);
            if (flags.onlyComparable) {
                const hasVerifyCode = !!enriched.verifyCode;
                const hasCaptchaFlow = Array.isArray(enriched.captchaFlow?.requestActions) &&
                    enriched.captchaFlow.requestActions.length > 0;
                if (!hasVerifyCode || !hasCaptchaFlow) {
                    continue;
                }
            }
            attempts.push(flattenAttempt(runName, run, enriched));
        }
    }
    const summary = summarizeAttempts(attempts);
    const successfulAttempts = attempts
        .filter((attempt) => attempt.success)
        .sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))
        .slice(0, 20);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        runsScanned: perRun.length,
        filters: {
            onlyComparable: flags.onlyComparable,
            auditJson: flags.auditJson,
            excludeRuns: [...excludedRuns],
        },
        stats: summary,
        recentSuccessfulAttempts: successfulAttempts,
        recentRuns: perRun.slice(0, 20),
    };
    if (flags.output) {
        await writeFile(flags.output, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log('=== Isolated Runs Report ===');
    console.log(`Runs scanned: ${report.runsScanned}`);
    console.log(`Attempts: ${summary.totalAttempts}`);
    console.log(`Success rate: ${summary.successCount}/${summary.totalAttempts} (${(summary.successRate * 100).toFixed(1)}%)`);
    console.log(`Verify codes: ${sortEntries(summary.verifyCodeCounts).map(([code, count]) => `${code}=${count}`).join(', ')}`);
    console.log(`Profiles: ${sortEntries(summary.profileCounts).map(([name, count]) => `${name}=${count}`).join(', ')}`);
    console.log('Recent successes:');
    if (successfulAttempts.length === 0) {
        console.log('  none');
    }
    else {
        for (const attempt of successfulAttempts) {
            console.log(`  ${attempt.runName} attempt-${String(attempt.attempt).padStart(2, '0')} code=${attempt.verifyCode} errorPx=${attempt.releasePositionErrorPx ?? 'n/a'} profile=${attempt.gestureProfile ?? 'n/a'}`);
        }
    }
    if (flags.output) {
        console.log(`Saved JSON report: ${flags.output}`);
    }
}
await main();
//# sourceMappingURL=report-runs.js.map