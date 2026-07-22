#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
    };
}
async function exists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
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
function classifyAttempt(audit) {
    const hasComparableArtifacts = audit.hasAnalysis &&
        audit.hasReleaseState &&
        audit.hasPostWaitState &&
        audit.hasBackground &&
        audit.hasPiece &&
        !!audit.verifyCode;
    if (hasComparableArtifacts) {
        return 'comparable';
    }
    if (audit.success && !audit.hasReleaseState) {
        return 'success_no_release';
    }
    const error = (audit.errorText || '').toLowerCase();
    if (audit.hasFailureState ||
        error.includes('captcha trigger not found') ||
        error.includes('timeout') ||
        (!audit.hasPuzzleOpenState && !audit.hasReleaseState)) {
        return 'flow_failure';
    }
    if (audit.hasEntryState ||
        audit.hasPuzzleOpenState ||
        audit.hasReleaseState ||
        audit.hasPostWaitState) {
        return 'partial';
    }
    return 'unknown';
}
async function auditAttempt(runName, attemptDir, attemptName) {
    const summaryPath = path.join(attemptDir, 'summary.json');
    const summary = await readJson(summaryPath);
    const base = {
        runName,
        attemptName,
        attemptDir,
        hasSummary: await exists(summaryPath),
        hasAnalysis: await exists(path.join(attemptDir, 'analysis.json')),
        hasEntryState: await exists(path.join(attemptDir, 'entry-state.json')),
        hasPuzzleOpenState: await exists(path.join(attemptDir, 'puzzle-open-state.json')),
        hasReleaseState: await exists(path.join(attemptDir, 'release-state.json')),
        hasPostWaitState: await exists(path.join(attemptDir, 'post-wait-state.json')),
        hasFailureState: await exists(path.join(attemptDir, 'failure-state.json')),
        hasBackground: await exists(path.join(attemptDir, 'background.png')),
        hasPiece: await exists(path.join(attemptDir, 'piece.png')),
        verifyCode: summary?.verifyCode || null,
        success: !!summary?.success,
        releasePositionErrorPx: typeof summary?.releasePositionErrorPx === 'number' && Number.isFinite(summary.releasePositionErrorPx)
            ? summary.releasePositionErrorPx
            : null,
        errorText: typeof summary?.error === 'string' ? summary.error : null,
    };
    return {
        ...base,
        classification: classifyAttempt(base),
    };
}
function buildRunAudit(runName, attempts) {
    const verifyCodeCounts = {};
    for (const attempt of attempts) {
        const code = attempt.verifyCode || 'n/a';
        verifyCodeCounts[code] = (verifyCodeCounts[code] || 0) + 1;
    }
    return {
        runName,
        attemptCount: attempts.length,
        comparableAttempts: attempts.filter((attempt) => attempt.classification === 'comparable').length,
        flowFailures: attempts.filter((attempt) => attempt.classification === 'flow_failure').length,
        partialAttempts: attempts.filter((attempt) => attempt.classification === 'partial').length,
        successes: attempts.filter((attempt) => attempt.success).length,
        verifyCodeCounts,
    };
}
function sortRecord(record) {
    return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
async function main() {
    const flags = parseArgs();
    const dirents = await readdir(flags.rootDir, { withFileTypes: true });
    let runNames = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (flags.limitRuns) {
        runNames = runNames.slice(0, flags.limitRuns);
    }
    const allAttempts = [];
    const runs = [];
    for (const runName of runNames) {
        const runDir = path.join(flags.rootDir, runName);
        const attempts = (await readdir(runDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && /^attempt-\d+$/i.test(entry.name))
            .map((entry) => entry.name)
            .sort();
        const audits = [];
        for (const attemptName of attempts) {
            const audit = await auditAttempt(runName, path.join(runDir, attemptName), attemptName);
            audits.push(audit);
            allAttempts.push(audit);
        }
        runs.push(buildRunAudit(runName, audits));
    }
    const classificationCounts = {};
    const verifyCodeCounts = {};
    for (const attempt of allAttempts) {
        classificationCounts[attempt.classification] = (classificationCounts[attempt.classification] || 0) + 1;
        const code = attempt.verifyCode || 'n/a';
        verifyCodeCounts[code] = (verifyCodeCounts[code] || 0) + 1;
    }
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        runsScanned: runs.length,
        attemptsScanned: allAttempts.length,
        classificationCounts,
        verifyCodeCounts,
        attemptClassifications: allAttempts.map((attempt) => ({
            runName: attempt.runName,
            attemptName: attempt.attemptName,
            classification: attempt.classification,
        })),
        runs: runs.slice(0, 50),
        problematicAttempts: allAttempts
            .filter((attempt) => attempt.classification !== 'comparable')
            .slice(0, 100),
    };
    if (flags.output) {
        await writeFile(flags.output, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log('=== Isolated Runs Audit ===');
    console.log(`Runs scanned: ${runs.length}`);
    console.log(`Attempts scanned: ${allAttempts.length}`);
    console.log(`Classifications: ${sortRecord(classificationCounts).map(([name, count]) => `${name}=${count}`).join(', ')}`);
    console.log(`Verify codes: ${sortRecord(verifyCodeCounts).map(([code, count]) => `${code}=${count}`).join(', ')}`);
    console.log('Top runs by comparable attempts:');
    for (const run of [...runs].sort((a, b) => b.comparableAttempts - a.comparableAttempts || a.runName.localeCompare(b.runName)).slice(0, 10)) {
        console.log(`  ${run.runName}: comparable=${run.comparableAttempts}/${run.attemptCount} flow_failures=${run.flowFailures} successes=${run.successes}`);
    }
    if (flags.output) {
        console.log(`Saved JSON audit: ${flags.output}`);
    }
}
await main();
//# sourceMappingURL=audit-runs.js.map