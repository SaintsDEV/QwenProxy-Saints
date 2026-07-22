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
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || 'manual-handoffs')),
        output: path.resolve(process.cwd(), String(flags.output || path.join('manual-handoffs', 'manual-dataset.json'))),
        limitRuns: Number(flags['limit-runs'] || 0) || null,
        onlyWithRelease: !!flags['only-with-release'],
        onlySuccess: !!flags['only-success'],
        verifyCode: flags['verify-code'] ? String(flags['verify-code']) : null,
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
async function listManualRunDirs(rootDir) {
    const dirents = await readdir(rootDir, { withFileTypes: true });
    const runs = [];
    for (const dirent of dirents) {
        if (!dirent.isDirectory())
            continue;
        const directDir = path.join(rootDir, dirent.name);
        const directSummary = await readJson(path.join(directDir, 'summary.json'));
        if (directSummary) {
            runs.push({ runName: dirent.name, runDir: directDir });
            continue;
        }
        const nestedDirents = await readdir(directDir, { withFileTypes: true }).catch(() => []);
        for (const nested of nestedDirents) {
            if (!nested.isDirectory())
                continue;
            const nestedDir = path.join(directDir, nested.name);
            const nestedSummary = await readJson(path.join(nestedDir, 'summary.json'));
            if (!nestedSummary)
                continue;
            runs.push({ runName: `${dirent.name}/${nested.name}`, runDir: nestedDir });
        }
    }
    return runs.sort((a, b) => b.runName.localeCompare(a.runName));
}
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function inferObservedReleaseCount(summary, releaseTimeline) {
    const summaryCount = toNumber(summary.observedReleaseCount);
    if (summaryCount != null)
        return summaryCount;
    const triggerCount = toNumber(releaseTimeline?.trigger?.observedReleaseCount);
    if (triggerCount != null)
        return triggerCount;
    const timelineLength = Array.isArray(releaseTimeline?.timeline) ? releaseTimeline.timeline.length : 0;
    return timelineLength > 0 ? timelineLength : null;
}
async function buildRow(runName, runDir, summary) {
    const releaseTimelinePath = path.join(runDir, 'release-timeline.json');
    const releaseStatePath = path.join(runDir, 'release-state.json');
    const releaseTimeline = await readJson(releaseTimelinePath);
    const releaseState = await readJson(releaseStatePath);
    const observedReleaseCount = inferObservedReleaseCount(summary, releaseTimeline);
    const releaseTimelinePhases = Array.isArray(summary.release?.timelinePhases) && summary.release.timelinePhases.length > 0
        ? summary.release.timelinePhases
        : Array.isArray(releaseTimeline?.timeline)
            ? releaseTimeline.timeline.map((entry) => String(entry?.phase || 'unknown'))
            : [];
    return {
        runName,
        runDir,
        finishedAt: summary.finishedAt || null,
        outcome: String(summary.outcome || 'unknown'),
        success: !!summary.success,
        verifyCode: String(summary.verifyCode || 'n/a'),
        certifyId: summary.certifyId || null,
        elapsedMs: toNumber(summary.elapsedMs),
        observedReleaseCount,
        releaseObserved: Number(observedReleaseCount || 0) > 0,
        releaseTriggerReason: typeof releaseTimeline?.trigger?.reason === 'string' && releaseTimeline.trigger.reason
            ? releaseTimeline.trigger.reason
            : null,
        releaseTimelineLength: releaseTimelinePhases.length,
        confidence: toNumber(summary.confidence),
        targetX: toNumber(summary.targetX),
        targetDisplayX: toNumber(summary.targetDisplayX),
        releasePositionErrorPx: toNumber(summary.releasePositionErrorPx) ??
            toNumber(releaseState?.releasePositionErrorPx),
        releaseSettledPositionErrorPx: toNumber(summary.releaseSettledPositionErrorPx) ??
            toNumber(releaseState?.releaseSettledPositionErrorPx),
        captchaVerifyParamCaptured: !!summary.captchaVerifyParamCaptured,
        gestureProfile: summary.gestureProfile || null,
        matchMethod: summary.match?.method || null,
        edgeX: toNumber(summary.match?.edgeX),
        contourX: toNumber(summary.match?.contourX),
        gapX: toNumber(summary.match?.gapX),
        nccX: toNumber(summary.match?.nccX),
        scaleX: toNumber(summary.scaleX),
        captchaRequestCount: toNumber(summary.captchaFlow?.requestCount),
        captchaResponseCount: toNumber(summary.captchaFlow?.responseCount),
        captchaRequestActions: Array.isArray(summary.captchaFlow?.requestActions)
            ? summary.captchaFlow.requestActions.map((entry) => String(entry?.action || 'n/a'))
            : [],
        captchaResponseCodes: Array.isArray(summary.captchaFlow?.responseActions)
            ? summary.captchaFlow.responseActions.map((entry) => String(entry?.code || 'n/a'))
            : [],
        releaseVerifyCode: summary.release?.verifyCode || releaseState?.verifyCode || null,
        releaseCapturedAt: summary.release?.capturedAt || null,
        releaseHasExactSnapshot: !!summary.release?.exactSnapshot || !!releaseTimeline?.exact || !!releaseState?.exactReleaseSnapshot,
        releaseHasSettledSnapshot: !!summary.release?.settledSnapshot || !!releaseTimeline?.latest || !!releaseState?.settledReleaseSnapshot,
        releaseTimelinePhases,
        artifactSummaryPath: path.join(runDir, 'summary.json'),
        artifactReleaseStatePath: releaseStatePath,
        artifactReleaseTimelinePath: releaseTimelinePath,
        artifactPostWaitStatePath: path.join(runDir, 'post-wait-state.json'),
    };
}
async function main() {
    const flags = parseArgs();
    let runs = await listManualRunDirs(flags.rootDir);
    if (flags.limitRuns) {
        runs = runs.slice(0, flags.limitRuns);
    }
    const rows = [];
    for (const run of runs) {
        const runName = run.runName;
        const runDir = run.runDir;
        const summary = await readJson(path.join(runDir, 'summary.json'));
        if (!summary)
            continue;
        const row = await buildRow(runName, runDir, summary);
        if (flags.onlyWithRelease && !row.releaseObserved)
            continue;
        if (flags.onlySuccess && !row.success)
            continue;
        if (flags.verifyCode && row.verifyCode !== flags.verifyCode)
            continue;
        rows.push(row);
    }
    const outcomeCounts = {};
    const verifyCodeCounts = {};
    let releaseObservedCount = 0;
    for (const row of rows) {
        outcomeCounts[row.outcome] = (outcomeCounts[row.outcome] || 0) + 1;
        verifyCodeCounts[row.verifyCode] = (verifyCodeCounts[row.verifyCode] || 0) + 1;
        if (row.releaseObserved)
            releaseObservedCount++;
    }
    const dataset = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        filters: {
            onlyWithRelease: flags.onlyWithRelease,
            onlySuccess: flags.onlySuccess,
            verifyCode: flags.verifyCode,
            limitRuns: flags.limitRuns,
        },
        stats: {
            rows: rows.length,
            outcomeCounts,
            verifyCodeCounts,
            releaseObservedCount,
        },
        rows,
    };
    await writeFile(flags.output, JSON.stringify(dataset, null, 2), 'utf8');
    console.log('=== Manual Handoff Dataset Export ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Outcomes: ${Object.entries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Verify codes: ${Object.entries(verifyCodeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Release observed: ${releaseObservedCount}/${rows.length}`);
    console.log(`Saved dataset: ${flags.output}`);
}
await main();
//# sourceMappingURL=export-manual-handoffs.js.map