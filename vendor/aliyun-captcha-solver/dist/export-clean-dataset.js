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
        auditJson: path.resolve(process.cwd(), String(flags['audit-json'] || path.join('isolated-runs', 'runs-audit.json'))),
        output: path.resolve(process.cwd(), String(flags.output || path.join('isolated-runs', 'comparable-dataset.json'))),
        limitRuns: Number(flags['limit-runs'] || 0) || null,
        profile: flags.profile ? String(flags.profile) : null,
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
function classifyOutcome(verifyCode, success) {
    if (success || verifyCode === 'T001')
        return 'pass';
    if (verifyCode === 'F001')
        return 'fail_f001';
    if (verifyCode === 'F015')
        return 'fail_f015';
    return 'fail_other';
}
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function buildRow(runName, attemptName, summary) {
    const verifyCode = String(summary.verifyCode || 'n/a');
    const attemptDir = String(summary.attemptDir || '');
    return {
        runName,
        attemptName,
        attemptNumber: Number(summary.attempt || 0),
        attemptDir,
        success: !!summary.success,
        verifyCode,
        outcomeLabel: classifyOutcome(verifyCode, !!summary.success),
        certifyId: summary.certifyId || null,
        gestureProfile: summary.gestureProfile || null,
        confidence: toNumber(summary.confidence),
        targetX: toNumber(summary.targetX),
        targetDisplayX: toNumber(summary.targetDisplayX),
        releasePositionErrorPx: toNumber(summary.releasePositionErrorPx),
        releaseSettledPositionErrorPx: toNumber(summary.releaseSettledPositionErrorPx),
        releaseCaptureLagMs: toNumber(summary.releaseCaptureLagMs),
        captchaVerifyParamCaptured: !!summary.captchaVerifyParamCaptured,
        matchMethod: summary.match?.method || null,
        edgeX: toNumber(summary.match?.edgeX),
        contourX: toNumber(summary.match?.contourX),
        gapX: toNumber(summary.match?.gapX),
        nccX: toNumber(summary.match?.nccX),
        correctionMoves: toNumber(summary.dragResult?.correctionMoves),
        fineTuneMoves: toNumber(summary.dragResult?.fineTuneMoves),
        correctionDelta: toNumber(summary.dragResult?.correctionDelta),
        gestureDurationMs: toNumber(summary.dragResult?.gestureDurationMs),
        trackPoints: toNumber(summary.trackSummary?.points),
        trackDurationMs: toNumber(summary.trackSummary?.durationMs),
        trackXRange: toNumber(summary.trackSummary?.xRange),
        trackYRange: toNumber(summary.trackSummary?.yRange),
        trackMaxStepPx: toNumber(summary.trackSummary?.maxStepPx),
        trackPausesOver40ms: toNumber(summary.trackSummary?.pausesOver40ms),
        dragTotalEvents: toNumber(summary.dragEventSummary?.totalEvents),
        dragMoveEvents: toNumber(summary.dragEventSummary?.moveEvents),
        dragDurationMs: toNumber(summary.dragEventSummary?.durationMs),
        dragStartToReleaseMs: toNumber(summary.dragEventSummary?.startToReleaseMs),
        dragTotalDx: toNumber(summary.dragEventSummary?.totalDx),
        dragTotalDy: toNumber(summary.dragEventSummary?.totalDy),
        dragMaxStepPx: toNumber(summary.dragEventSummary?.maxStepPx),
        dragNegativeDxCount: toNumber(summary.dragEventSummary?.negativeDxCount),
        dragMaxBacktrackPx: toNumber(summary.dragEventSummary?.maxBacktrackPx),
        dragPausesOver40ms: toNumber(summary.dragEventSummary?.pausesOver40ms),
        captchaRequestCount: toNumber(summary.captchaFlow?.requestCount),
        captchaResponseCount: toNumber(summary.captchaFlow?.responseCount),
        captchaRequestActions: Array.isArray(summary.captchaFlow?.requestActions)
            ? summary.captchaFlow.requestActions.map((entry) => String(entry?.action || 'n/a'))
            : [],
        captchaResponseCodes: Array.isArray(summary.captchaFlow?.responseActions)
            ? summary.captchaFlow.responseActions.map((entry) => String(entry?.code || 'n/a'))
            : [],
        releaseVerifyCode: summary.release?.verifyCode || null,
        postWaitVerifyCode: summary.postWait?.verifyCode || null,
        releaseResultSuccess: typeof summary.release?.result?.success === 'boolean' ? summary.release.result.success : null,
        releaseHasFailureMessage: typeof summary.release?.result?.hasFailureMessage === 'boolean' ? summary.release.result.hasFailureMessage : null,
        releaseTimedOut: typeof summary.release?.result?.timedOut === 'boolean' ? summary.release.result.timedOut : null,
        releaseFailureReason: summary.release?.result?.failureReason || null,
        releaseVerifyResponseSuccess: typeof summary.release?.result?.verifyResponseSuccess === 'boolean' ? summary.release.result.verifyResponseSuccess : null,
        postWaitResultSuccess: typeof summary.postWait?.result?.success === 'boolean' ? summary.postWait.result.success : null,
        postWaitHasFailureMessage: typeof summary.postWait?.result?.hasFailureMessage === 'boolean' ? summary.postWait.result.hasFailureMessage : null,
        postWaitTimedOut: typeof summary.postWait?.result?.timedOut === 'boolean' ? summary.postWait.result.timedOut : null,
        postWaitFailureReason: summary.postWait?.result?.failureReason || null,
        postWaitVerifyResponseSuccess: typeof summary.postWait?.result?.verifyResponseSuccess === 'boolean' ? summary.postWait.result.verifyResponseSuccess : null,
        artifactSummaryPath: path.join(attemptDir, 'summary.json'),
        artifactReleaseStatePath: path.join(attemptDir, 'release-state.json'),
        artifactReleaseTimelinePath: path.join(attemptDir, 'release-timeline.json'),
        artifactPostWaitStatePath: path.join(attemptDir, 'post-wait-state.json'),
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
    let runNames = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !excludedRuns.has(name))
        .sort()
        .reverse();
    if (flags.limitRuns) {
        runNames = runNames.slice(0, flags.limitRuns);
    }
    const rows = [];
    for (const runName of runNames) {
        const runDir = path.join(flags.rootDir, runName);
        const attemptDirents = await readdir(runDir, { withFileTypes: true }).catch(() => []);
        for (const attemptDirent of attemptDirents) {
            if (!attemptDirent.isDirectory() || !/^attempt-\d+$/i.test(attemptDirent.name))
                continue;
            const attemptKey = `${runName}/${attemptDirent.name}`;
            if (!comparableKeys.has(attemptKey))
                continue;
            const summary = await readJson(path.join(runDir, attemptDirent.name, 'summary.json'));
            if (!summary)
                continue;
            if (!summary.verifyCode)
                continue;
            if (flags.profile && summary.gestureProfile !== flags.profile)
                continue;
            rows.push(buildRow(runName, attemptDirent.name, summary));
        }
    }
    const outcomeCounts = {};
    const verifyCodeCounts = {};
    for (const row of rows) {
        outcomeCounts[row.outcomeLabel] = (outcomeCounts[row.outcomeLabel] || 0) + 1;
        verifyCodeCounts[row.verifyCode] = (verifyCodeCounts[row.verifyCode] || 0) + 1;
    }
    const dataset = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        filters: {
            auditJson: flags.auditJson,
            profile: flags.profile,
            excludeRuns: [...excludedRuns],
            limitRuns: flags.limitRuns,
        },
        stats: {
            rows: rows.length,
            outcomeCounts,
            verifyCodeCounts,
        },
        rows,
    };
    await writeFile(flags.output, JSON.stringify(dataset, null, 2), 'utf8');
    console.log('=== Comparable Dataset Export ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Outcomes: ${Object.entries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Verify codes: ${Object.entries(verifyCodeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Saved dataset: ${flags.output}`);
}
await main();
//# sourceMappingURL=export-clean-dataset.js.map