#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const FEATURE_KEYS = [
    'releasePositionErrorPx',
    'confidence',
    'gestureDurationMs',
    'correctionMoves',
    'fineTuneMoves',
    'trackDurationMs',
    'trackPoints',
    'trackXRange',
    'trackPausesOver40ms',
    'releaseDurationMs',
    'totalDx',
    'negativeDxCount',
    'maxBacktrackPx',
    'dragPausesOver40ms',
];
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
        auditJson: path.resolve(process.cwd(), String(flags['audit-json'] || path.join('isolated-runs', 'runs-audit.json'))),
        output: flags.output ? path.resolve(process.cwd(), String(flags.output)) : null,
        limitRuns: Number(flags['limit-runs'] || 0) || null,
        profile: flags.profile ? String(flags.profile) : null,
        successCode: String(flags['success-code'] || 'T001'),
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
function isComparableAttempt(detail, runName, attemptName, comparableKeys, excludedRuns, profile) {
    if (excludedRuns.has(runName))
        return false;
    if (!comparableKeys.has(`${runName}/${attemptName}`))
        return false;
    if (!detail.verifyCode)
        return false;
    if (!Array.isArray(detail.captchaFlow?.requestActions) || detail.captchaFlow.requestActions.length === 0) {
        return false;
    }
    if (profile && detail.gestureProfile !== profile)
        return false;
    return true;
}
function toComparableAttempt(runName, attemptName, detail) {
    return {
        runName,
        attemptName,
        verifyCode: String(detail.verifyCode || 'n/a'),
        success: !!detail.success,
        gestureProfile: detail.gestureProfile || null,
        features: {
            releasePositionErrorPx: Number(detail.releasePositionErrorPx ?? 0),
            confidence: Number(detail.confidence ?? 0),
            gestureDurationMs: Number(detail.dragResult?.gestureDurationMs ?? 0),
            correctionMoves: Number(detail.dragResult?.correctionMoves ?? 0),
            fineTuneMoves: Number(detail.dragResult?.fineTuneMoves ?? 0),
            trackDurationMs: Number(detail.trackSummary?.durationMs ?? 0),
            trackPoints: Number(detail.trackSummary?.points ?? 0),
            trackXRange: Number(detail.trackSummary?.xRange ?? 0),
            trackPausesOver40ms: Number(detail.trackSummary?.pausesOver40ms ?? 0),
            releaseDurationMs: Number(detail.dragEventSummary?.startToReleaseMs ?? 0),
            totalDx: Number(detail.dragEventSummary?.totalDx ?? 0),
            negativeDxCount: Number(detail.dragEventSummary?.negativeDxCount ?? 0),
            maxBacktrackPx: Number(detail.dragEventSummary?.maxBacktrackPx ?? 0),
            dragPausesOver40ms: Number(detail.dragEventSummary?.pausesOver40ms ?? 0),
        },
    };
}
function buildReference(successes) {
    const reference = {};
    for (const key of FEATURE_KEYS) {
        reference[key] =
            successes.reduce((sum, attempt) => sum + attempt.features[key], 0) /
                Math.max(successes.length, 1);
    }
    return reference;
}
function buildScales(attempts) {
    const scales = {};
    for (const key of FEATURE_KEYS) {
        const values = attempts.map((attempt) => attempt.features[key]);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = max - min;
        scales[key] = span > 0 ? span : 1;
    }
    return scales;
}
function compareAttempts(attempt, reference, scales) {
    let distance = 0;
    const deltas = {};
    for (const key of FEATURE_KEYS) {
        const delta = attempt.features[key] - reference[key];
        deltas[key] = Number(delta.toFixed(3));
        distance += Math.abs(delta) / scales[key];
    }
    return {
        ...attempt,
        distance: Number(distance.toFixed(4)),
        deltas,
    };
}
async function main() {
    const flags = parseArgs();
    const audit = await readJson(flags.auditJson);
    const comparableKeys = new Set((audit?.attemptClassifications || [])
        .filter((entry) => entry?.classification === 'comparable')
        .map((entry) => `${entry?.runName}/${entry?.attemptName}`));
    const excludedRuns = new Set(flags.excludeRuns);
    const dirents = await readdir(flags.rootDir, { withFileTypes: true });
    let runNames = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (flags.limitRuns) {
        runNames = runNames.slice(0, flags.limitRuns);
    }
    const comparableAttempts = [];
    for (const runName of runNames) {
        const runDir = path.join(flags.rootDir, runName);
        const attemptDirents = await readdir(runDir, { withFileTypes: true }).catch(() => []);
        for (const attemptDirent of attemptDirents) {
            if (!attemptDirent.isDirectory() || !/^attempt-\d+$/i.test(attemptDirent.name))
                continue;
            const detail = await readJson(path.join(runDir, attemptDirent.name, 'summary.json'));
            if (!detail)
                continue;
            if (!isComparableAttempt(detail, runName, attemptDirent.name, comparableKeys, excludedRuns, flags.profile)) {
                continue;
            }
            comparableAttempts.push(toComparableAttempt(runName, attemptDirent.name, detail));
        }
    }
    const successes = comparableAttempts.filter((attempt) => attempt.verifyCode === flags.successCode || attempt.success);
    if (successes.length === 0) {
        throw new Error(`No comparable success attempts found for code ${flags.successCode}`);
    }
    const reference = buildReference(successes);
    const scales = buildScales(comparableAttempts);
    const rankedFailures = comparableAttempts
        .filter((attempt) => !successes.includes(attempt))
        .map((attempt) => compareAttempts(attempt, reference, scales))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        filters: {
            profile: flags.profile,
            successCode: flags.successCode,
            excludeRuns: [...excludedRuns],
            auditJson: flags.auditJson,
        },
        comparableAttempts: comparableAttempts.length,
        successAttempts: successes.map((attempt) => ({
            runName: attempt.runName,
            attemptName: attempt.attemptName,
            verifyCode: attempt.verifyCode,
            features: attempt.features,
        })),
        nearestFailures: rankedFailures,
    };
    if (flags.output) {
        await writeFile(flags.output, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log('=== Comparable Attempt Diff ===');
    console.log(`Comparable attempts: ${comparableAttempts.length}`);
    console.log(`Success references: ${successes.length}`);
    console.log('Nearest failures to success:');
    for (const failure of rankedFailures) {
        console.log(`  ${failure.runName}/${failure.attemptName} code=${failure.verifyCode} distance=${failure.distance} errorPx=${failure.features.releasePositionErrorPx} duration=${failure.features.gestureDurationMs}`);
    }
    if (flags.output) {
        console.log(`Saved comparison report: ${flags.output}`);
    }
}
await main();
//# sourceMappingURL=compare-clean-attempts.js.map