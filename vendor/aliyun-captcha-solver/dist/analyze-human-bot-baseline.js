#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const NUMERIC_FEATURES = [
    'dragDurationMs',
    'avgSpeedPxPerMs',
    'last30SpeedPxPerMs',
    'microAdjustmentsFinal',
    'directionReversals',
    'totalDistancePx',
    'idealDistancePx',
    'distanceOverIdeal',
    'timeLastMoveToReleaseMs',
    'releaseToLog3Ms',
    'releaseToVerifyMs',
    'releasePositionErrorPx',
    'releaseSettledPositionErrorPx',
    'releaseCaptureLagMs',
    'captchaDataLength',
    'deviceTokenLength',
    'dragTotalDx',
    'dragTotalDy',
    'dragNegativeDxCount',
    'dragMaxBacktrackPx',
    'dragPausesOver40ms',
    'dispatchAvgLagMs',
    'dispatchMaxLagMs',
    'trackDurationMs',
    'trackPoints',
    'trackXRange',
    'trackYRange',
    'trackMaxStepPx',
    'trackPausesOver40ms',
    'rawDragEventCount',
    'releaseTsOffsetMs',
    'settledTsOffsetMs',
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
        humanRun: flags['human-run'] ? String(flags['human-run']) : null,
        outputDir: flags['output-dir'] ? path.resolve(process.cwd(), String(flags['output-dir'])) : null,
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
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function round(value, digits = 3) {
    if (value == null || !Number.isFinite(value))
        return null;
    return Number(value.toFixed(digits));
}
function parsePx(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string')
        return null;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match)
        return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}
function average(values) {
    if (values.length === 0)
        return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function median(values) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}
function quantile(values, ratio) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const index = (sorted.length - 1) * ratio;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (lower === upper)
        return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}
function standardDeviation(values) {
    if (values.length === 0)
        return null;
    const mean = average(values);
    if (mean == null)
        return null;
    const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) /
        values.length;
    return Math.sqrt(variance);
}
async function findLatestHumanRun(rootDir) {
    const dirents = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const candidates = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    for (const runName of candidates) {
        const runSummary = await readJson(path.join(rootDir, runName, 'summary.json'));
        if (runSummary?.options?.mode === 'human') {
            return runName;
        }
    }
    return null;
}
function inferMode(summary, runName, humanRun) {
    if (runName === humanRun)
        return 'human';
    if (summary.mode === 'human')
        return 'human';
    return 'bot';
}
function normalizeDragEvents(rawEvents) {
    const pointerEvents = rawEvents.filter((event) => String(event?.type || '').startsWith('pointer'));
    const mouseEvents = rawEvents.filter((event) => String(event?.type || '').startsWith('mouse'));
    const source = pointerEvents.length >= 3 ? pointerEvents : mouseEvents.length >= 3 ? mouseEvents : rawEvents;
    return source
        .filter((event) => typeof event?.ts === 'number' &&
        typeof event?.x === 'number' &&
        typeof event?.y === 'number' &&
        Number.isFinite(event.ts) &&
        Number.isFinite(event.x) &&
        Number.isFinite(event.y))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
}
function computeMotionMetrics(events) {
    const ordered = normalizeDragEvents(events);
    if (ordered.length === 0) {
        return {
            dragDurationMs: null,
            totalDistancePx: null,
            idealDistancePx: null,
            avgSpeedPxPerMs: null,
            last30SpeedPxPerMs: null,
            microAdjustmentsFinal: null,
            directionReversals: null,
            distanceOverIdeal: null,
            timeLastMoveToReleaseMs: null,
            dragTotalDx: null,
            dragTotalDy: null,
            rawDragEventCount: 0,
            releaseTs: null,
        };
    }
    const isDown = (event) => /down$/i.test(String(event.type || '')) || event.phase === 'drag_start';
    const isUp = (event) => /up$/i.test(String(event.type || '')) || event.phase === 'drag_release';
    const isMove = (event) => /move$/i.test(String(event.type || '')) || event.phase === 'drag_move';
    const start = ordered.find(isDown) || ordered[0];
    const end = [...ordered].reverse().find(isUp) || ordered[ordered.length - 1];
    const moveEvents = ordered.filter(isMove);
    const usableMoves = moveEvents.length > 0 ? moveEvents : ordered;
    let totalDistancePx = 0;
    let dragTotalDx = 0;
    let dragTotalDy = 0;
    let directionReversals = 0;
    let previousDxSign = 0;
    for (let i = 1; i < usableMoves.length; i++) {
        const dx = Number(usableMoves[i].x) - Number(usableMoves[i - 1].x);
        const dy = Number(usableMoves[i].y) - Number(usableMoves[i - 1].y);
        dragTotalDx += dx;
        dragTotalDy += dy;
        totalDistancePx += Math.sqrt(dx * dx + dy * dy);
        const sign = Math.abs(dx) >= 1 ? Math.sign(dx) : 0;
        if (sign !== 0 && previousDxSign !== 0 && sign !== previousDxSign) {
            directionReversals++;
        }
        if (sign !== 0) {
            previousDxSign = sign;
        }
    }
    const dragDurationMs = Math.max(0, Number(end.ts) - Number(start.ts));
    const idealDistancePx = Math.abs(Number(end.x) - Number(start.x));
    const avgSpeedPxPerMs = dragDurationMs > 0 ? totalDistancePx / dragDurationMs : null;
    const thresholdTs = Number(start.ts) + dragDurationMs * 0.7;
    const tailEvents = usableMoves.filter((event) => Number(event.ts) >= thresholdTs);
    let tailDistancePx = 0;
    for (let i = 1; i < tailEvents.length; i++) {
        const dx = Number(tailEvents[i].x) - Number(tailEvents[i - 1].x);
        const dy = Number(tailEvents[i].y) - Number(tailEvents[i - 1].y);
        tailDistancePx += Math.sqrt(dx * dx + dy * dy);
    }
    const tailDurationMs = tailEvents.length >= 2
        ? Math.max(0, Number(tailEvents[tailEvents.length - 1].ts) - Number(tailEvents[0].ts))
        : 0;
    const last30SpeedPxPerMs = tailDurationMs > 0 ? tailDistancePx / tailDurationMs : null;
    const fineTail = usableMoves.slice(-8);
    let microAdjustmentsFinal = 0;
    for (let i = 2; i < fineTail.length; i++) {
        const prevDx = Number(fineTail[i - 1].x) - Number(fineTail[i - 2].x);
        const nextDx = Number(fineTail[i].x) - Number(fineTail[i - 1].x);
        if (Math.abs(prevDx) >= 1 && Math.abs(nextDx) >= 1 && Math.sign(prevDx) !== Math.sign(nextDx)) {
            microAdjustmentsFinal++;
        }
    }
    const lastMove = usableMoves[usableMoves.length - 1] || null;
    const timeLastMoveToReleaseMs = lastMove && end ? Math.max(0, Number(end.ts) - Number(lastMove.ts)) : null;
    return {
        dragDurationMs: round(dragDurationMs),
        totalDistancePx: round(totalDistancePx),
        idealDistancePx: round(idealDistancePx),
        avgSpeedPxPerMs: round(avgSpeedPxPerMs),
        last30SpeedPxPerMs: round(last30SpeedPxPerMs),
        microAdjustmentsFinal,
        directionReversals,
        distanceOverIdeal: idealDistancePx > 0 ? round(totalDistancePx / idealDistancePx) : null,
        timeLastMoveToReleaseMs: round(timeLastMoveToReleaseMs),
        dragTotalDx: round(dragTotalDx),
        dragTotalDy: round(dragTotalDy),
        rawDragEventCount: ordered.length,
        releaseTs: toNumber(end.ts),
    };
}
function findCaptchaTimings(timeline, releaseTs) {
    const log3 = timeline.find((entry) => entry.direction === 'request' && entry.label === 'Log3' && typeof entry.ts === 'number') || null;
    const verify = timeline.find((entry) => entry.direction === 'request' && entry.label === 'VerifyCaptchaV3' && typeof entry.ts === 'number') || null;
    return {
        releaseToLog3Ms: releaseTs != null && log3?.ts != null ? round(Number(log3.ts) - releaseTs) : null,
        releaseToVerifyMs: releaseTs != null && verify?.ts != null ? round(Number(verify.ts) - releaseTs) : null,
        captchaVerifyParamInfo: verify?.captchaVerifyParamInfo || null,
    };
}
function buildAttemptReference(runName, attemptName, summary, mode) {
    const attemptDir = String(summary.attemptDir || path.join(runName, attemptName));
    return {
        runName,
        attemptName,
        attemptNumber: Number(summary.attempt || 0),
        verifyCode: String(summary.verifyCode || 'n/a'),
        success: !!summary.success,
        mode,
        attemptDir,
        summaryPath: path.join(attemptDir, 'summary.json'),
        releaseStatePath: path.join(attemptDir, 'release-state.json'),
    };
}
function buildFeatureRow(reference, summary, releaseState, group) {
    const rawEvents = Array.isArray(releaseState?.context?.page?.dragEvents)
        ? releaseState.context.page.dragEvents
        : [];
    const motion = computeMotionMetrics(rawEvents);
    const captchaTimeline = Array.isArray(releaseState?.captchaFlow?.timeline)
        ? releaseState.captchaFlow.timeline
        : Array.isArray(summary.captchaFlow?.timeline)
            ? summary.captchaFlow.timeline
            : [];
    const captcha = findCaptchaTimings(captchaTimeline, motion.releaseTs);
    const exactTs = toNumber(releaseState?.exactReleaseSnapshot?.ts);
    const settledTs = toNumber(releaseState?.settledReleaseSnapshot?.ts);
    return {
        ...reference,
        group,
        numeric: {
            dragDurationMs: motion.dragDurationMs,
            avgSpeedPxPerMs: motion.avgSpeedPxPerMs,
            last30SpeedPxPerMs: motion.last30SpeedPxPerMs,
            microAdjustmentsFinal: motion.microAdjustmentsFinal,
            directionReversals: motion.directionReversals,
            totalDistancePx: motion.totalDistancePx,
            idealDistancePx: motion.idealDistancePx,
            distanceOverIdeal: motion.distanceOverIdeal,
            timeLastMoveToReleaseMs: motion.timeLastMoveToReleaseMs,
            releaseToLog3Ms: captcha.releaseToLog3Ms,
            releaseToVerifyMs: captcha.releaseToVerifyMs,
            releasePositionErrorPx: toNumber(summary.releasePositionErrorPx),
            releaseSettledPositionErrorPx: toNumber(summary.releaseSettledPositionErrorPx),
            releaseCaptureLagMs: toNumber(summary.releaseCaptureLagMs),
            captchaDataLength: toNumber(captcha.captchaVerifyParamInfo?.dataLength),
            deviceTokenLength: toNumber(captcha.captchaVerifyParamInfo?.deviceTokenLength),
            dragTotalDx: motion.dragTotalDx ?? toNumber(summary.dragEventSummary?.totalDx),
            dragTotalDy: motion.dragTotalDy ?? toNumber(summary.dragEventSummary?.totalDy),
            dragNegativeDxCount: toNumber(summary.dragEventSummary?.negativeDxCount),
            dragMaxBacktrackPx: toNumber(summary.dragEventSummary?.maxBacktrackPx),
            dragPausesOver40ms: toNumber(summary.dragEventSummary?.pausesOver40ms),
            dispatchAvgLagMs: toNumber(summary.dispatchVsDom?.avgLagMs),
            dispatchMaxLagMs: toNumber(summary.dispatchVsDom?.maxLagMs),
            trackDurationMs: toNumber(summary.trackSummary?.durationMs),
            trackPoints: toNumber(summary.trackSummary?.points),
            trackXRange: toNumber(summary.trackSummary?.xRange),
            trackYRange: toNumber(summary.trackSummary?.yRange),
            trackMaxStepPx: toNumber(summary.trackSummary?.maxStepPx),
            trackPausesOver40ms: toNumber(summary.trackSummary?.pausesOver40ms),
            rawDragEventCount: motion.rawDragEventCount,
            releaseTsOffsetMs: motion.releaseTs != null && exactTs != null ? round(exactTs - motion.releaseTs) : null,
            settledTsOffsetMs: motion.releaseTs != null && settledTs != null ? round(settledTs - motion.releaseTs) : null,
        },
        categorical: {
            dataHash: captcha.captchaVerifyParamInfo?.dataHash || null,
            deviceTokenHash: captcha.captchaVerifyParamInfo?.deviceTokenHash || null,
            gestureProfile: summary.gestureProfile || null,
            outcome: summary.outcome || null,
        },
    };
}
function summarizeGroup(rows) {
    const verifyCodeCounts = {};
    for (const row of rows) {
        verifyCodeCounts[row.verifyCode] = (verifyCodeCounts[row.verifyCode] || 0) + 1;
    }
    const numeric = {};
    for (const feature of NUMERIC_FEATURES) {
        const values = rows
            .map((row) => row.numeric[feature])
            .filter((value) => typeof value === 'number' && Number.isFinite(value));
        numeric[feature] = {
            count: values.length,
            mean: round(average(values)),
            median: round(median(values)),
            p10: round(quantile(values, 0.1)),
            p90: round(quantile(values, 0.9)),
            min: values.length ? round(Math.min(...values)) : null,
            max: values.length ? round(Math.max(...values)) : null,
            std: round(standardDeviation(values)),
        };
    }
    const dataHashCounts = {};
    const deviceTokenHashCounts = {};
    for (const row of rows) {
        if (row.categorical.dataHash) {
            dataHashCounts[row.categorical.dataHash] = (dataHashCounts[row.categorical.dataHash] || 0) + 1;
        }
        if (row.categorical.deviceTokenHash) {
            deviceTokenHashCounts[row.categorical.deviceTokenHash] =
                (deviceTokenHashCounts[row.categorical.deviceTokenHash] || 0) + 1;
        }
    }
    return {
        count: rows.length,
        verifyCodeCounts,
        numeric,
        hashes: {
            uniqueDataHashes: Object.keys(dataHashCounts).length,
            uniqueDeviceTokenHashes: Object.keys(deviceTokenHashCounts).length,
            dataHashCounts,
            deviceTokenHashCounts,
        },
        attempts: rows.map((row) => ({
            runName: row.runName,
            attemptName: row.attemptName,
            verifyCode: row.verifyCode,
            success: row.success,
            attemptDir: row.attemptDir,
        })),
    };
}
function compareGroupMeans(referenceRows, sampleRows) {
    const output = NUMERIC_FEATURES.map((feature) => {
        const referenceValues = referenceRows
            .map((row) => row.numeric[feature])
            .filter((value) => typeof value === 'number' && Number.isFinite(value));
        const sampleValues = sampleRows
            .map((row) => row.numeric[feature])
            .filter((value) => typeof value === 'number' && Number.isFinite(value));
        const referenceMean = average(referenceValues);
        const sampleMean = average(sampleValues);
        const scale = Math.max(1, ...(referenceValues.length ? referenceValues : [1]), ...(sampleValues.length ? sampleValues : [1])) - Math.min(0, ...(referenceValues.length ? referenceValues : [0]), ...(sampleValues.length ? sampleValues : [0]));
        const delta = referenceMean != null && sampleMean != null ? sampleMean - referenceMean : null;
        const normalizedDelta = delta != null && scale > 0 ? delta / scale : null;
        return {
            feature,
            referenceMean: round(referenceMean),
            sampleMean: round(sampleMean),
            delta: round(delta),
            normalizedDelta: round(normalizedDelta, 4),
        };
    });
    return output.sort((a, b) => Math.abs(b.normalizedDelta || 0) - Math.abs(a.normalizedDelta || 0));
}
function buildCentroid(rows) {
    const centroid = {};
    for (const feature of NUMERIC_FEATURES) {
        centroid[feature] = average(rows
            .map((row) => row.numeric[feature])
            .filter((value) => typeof value === 'number' && Number.isFinite(value)));
    }
    return centroid;
}
function distanceToCentroid(row, centroid, rowsForScale) {
    let distance = 0;
    let compared = 0;
    for (const feature of NUMERIC_FEATURES) {
        const value = row.numeric[feature];
        const center = centroid[feature];
        if (value == null || center == null)
            continue;
        const allValues = rowsForScale
            .map((entry) => entry.numeric[feature])
            .filter((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
        const span = allValues.length ? Math.max(...allValues) - Math.min(...allValues) : 0;
        const scale = span > 0 ? span : 1;
        distance += Math.abs(value - center) / scale;
        compared++;
    }
    return {
        distance: compared ? round(distance / compared, 4) : null,
        comparedFeatures: compared,
    };
}
function pickGroup(rows, label) {
    return rows.filter((row) => row.group === label);
}
function resolveGroup(reference, humanRun) {
    if (reference.runName === humanRun) {
        if (reference.verifyCode === 'T001')
            return 'human_gold';
        if (reference.verifyCode === 'F001')
            return 'human_f001';
        if (reference.verifyCode === 'F015')
            return 'human_f015';
        return 'human_edge_case';
    }
    if (reference.mode !== 'bot')
        return null;
    if (reference.verifyCode === 'T001')
        return 'bot_t001';
    if (reference.verifyCode === 'F001')
        return 'bot_f001';
    if (reference.verifyCode === 'F015')
        return 'bot_f015';
    return null;
}
async function main() {
    const flags = parseArgs();
    const humanRun = flags.humanRun || await findLatestHumanRun(flags.rootDir);
    if (!humanRun) {
        throw new Error('Could not infer a human baseline run. Pass --human-run explicitly.');
    }
    const outputDir = flags.outputDir || path.join(flags.rootDir, 'baselines', humanRun);
    await mkdir(outputDir, { recursive: true });
    const excludedRuns = new Set(flags.excludeRuns);
    const dirents = await readdir(flags.rootDir, { withFileTypes: true });
    const runNames = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !excludedRuns.has(name))
        .sort();
    const references = [];
    const rows = [];
    for (const runName of runNames) {
        const runDir = path.join(flags.rootDir, runName);
        const attemptDirents = await readdir(runDir, { withFileTypes: true }).catch(() => []);
        for (const attemptDirent of attemptDirents) {
            if (!attemptDirent.isDirectory() || !/^attempt-\d+$/i.test(attemptDirent.name))
                continue;
            const attemptDir = path.join(runDir, attemptDirent.name);
            const summary = await readJson(path.join(attemptDir, 'summary.json'));
            if (!summary?.verifyCode)
                continue;
            const mode = inferMode(summary, runName, humanRun);
            if (mode === 'human' && runName !== humanRun)
                continue;
            const reference = buildAttemptReference(runName, attemptDirent.name, summary, mode);
            references.push(reference);
            const group = resolveGroup(reference, humanRun);
            if (!group)
                continue;
            const releaseState = await readJson(path.join(attemptDir, 'release-state.json'));
            rows.push(buildFeatureRow(reference, summary, releaseState, group));
        }
    }
    const humanMixed = rows.filter((row) => row.runName === humanRun);
    const humanGold = pickGroup(rows, 'human_gold');
    const humanEdgeCase = rows.filter((row) => row.runName === humanRun && row.verifyCode !== 'T001');
    const humanF001 = pickGroup(rows, 'human_f001');
    const botT001 = pickGroup(rows, 'bot_t001');
    const botF001 = pickGroup(rows, 'bot_f001');
    const botF015 = pickGroup(rows, 'bot_f015');
    const manifests = {
        human_gold: humanGold.map((row) => ({
            runName: row.runName,
            attemptName: row.attemptName,
            verifyCode: row.verifyCode,
            success: row.success,
            attemptDir: row.attemptDir,
        })),
        human_mixed: humanMixed.map((row) => ({
            runName: row.runName,
            attemptName: row.attemptName,
            verifyCode: row.verifyCode,
            success: row.success,
            attemptDir: row.attemptDir,
        })),
        human_edge_case: humanEdgeCase.map((row) => ({
            runName: row.runName,
            attemptName: row.attemptName,
            verifyCode: row.verifyCode,
            success: row.success,
            attemptDir: row.attemptDir,
        })),
    };
    await writeFile(path.join(outputDir, 'human-gold.json'), JSON.stringify(manifests.human_gold, null, 2), 'utf8');
    await writeFile(path.join(outputDir, 'human-mixed.json'), JSON.stringify(manifests.human_mixed, null, 2), 'utf8');
    await writeFile(path.join(outputDir, 'human-edge-case.json'), JSON.stringify(manifests.human_edge_case, null, 2), 'utf8');
    const humanGoldCentroid = buildCentroid(humanGold);
    const comparisonScaleRows = [
        ...humanGold,
        ...humanF001,
        ...botT001,
        ...botF001,
        ...botF015,
    ];
    const edgeCase = humanEdgeCase[0] || null;
    const edgeCaseAnalysis = edgeCase
        ? {
            attempt: {
                runName: edgeCase.runName,
                attemptName: edgeCase.attemptName,
                verifyCode: edgeCase.verifyCode,
                attemptDir: edgeCase.attemptDir,
            },
            centroidDistances: {
                human_gold: distanceToCentroid(edgeCase, buildCentroid(humanGold), comparisonScaleRows),
                bot_t001: distanceToCentroid(edgeCase, buildCentroid(botT001), comparisonScaleRows),
                bot_f001: distanceToCentroid(edgeCase, buildCentroid(botF001), comparisonScaleRows),
                bot_f015: distanceToCentroid(edgeCase, buildCentroid(botF015), comparisonScaleRows),
            },
            nearestHumanGold: humanGold
                .map((row) => ({
                row,
                distance: distanceToCentroid(row, buildCentroid([edgeCase]), comparisonScaleRows),
            }))
                .sort((a, b) => (a.distance.distance ?? Infinity) - (b.distance.distance ?? Infinity))
                .slice(0, 3)
                .map((entry) => ({
                runName: entry.row.runName,
                attemptName: entry.row.attemptName,
                verifyCode: entry.row.verifyCode,
                distance: entry.distance.distance,
            })),
            neighbors: humanMixed
                .filter((row) => Math.abs(row.attemptNumber - edgeCase.attemptNumber) <= 1 && row.attemptName !== edgeCase.attemptName)
                .sort((a, b) => a.attemptNumber - b.attemptNumber)
                .map((row) => ({
                runName: row.runName,
                attemptName: row.attemptName,
                attemptNumber: row.attemptNumber,
                verifyCode: row.verifyCode,
                success: row.success,
                keyMetrics: {
                    dragDurationMs: row.numeric.dragDurationMs,
                    avgSpeedPxPerMs: row.numeric.avgSpeedPxPerMs,
                    last30SpeedPxPerMs: row.numeric.last30SpeedPxPerMs,
                    microAdjustmentsFinal: row.numeric.microAdjustmentsFinal,
                    timeLastMoveToReleaseMs: row.numeric.timeLastMoveToReleaseMs,
                    releaseToLog3Ms: row.numeric.releaseToLog3Ms,
                    releaseToVerifyMs: row.numeric.releaseToVerifyMs,
                    releasePositionErrorPx: row.numeric.releasePositionErrorPx,
                    captchaDataLength: row.numeric.captchaDataLength,
                    deviceTokenLength: row.numeric.deviceTokenLength,
                },
            })),
        }
        : null;
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        baseline: {
            humanRun,
            manifests: {
                humanGold: path.join(outputDir, 'human-gold.json'),
                humanMixed: path.join(outputDir, 'human-mixed.json'),
                humanEdgeCase: path.join(outputDir, 'human-edge-case.json'),
            },
            counts: {
                human_gold: humanGold.length,
                human_mixed: humanMixed.length,
                human_edge_case: humanEdgeCase.length,
            },
        },
        botPool: {
            totalBotComparableAttempts: botT001.length + botF001.length + botF015.length,
            verifyCodeCounts: {
                T001: botT001.length,
                F001: botF001.length,
                F015: botF015.length,
            },
        },
        groups: {
            human_gold: summarizeGroup(humanGold),
            human_mixed: summarizeGroup(humanMixed),
            human_edge_case: summarizeGroup(humanEdgeCase),
            human_f001: summarizeGroup(humanF001),
            bot_t001: summarizeGroup(botT001),
            bot_f001: summarizeGroup(botF001),
            bot_f015: summarizeGroup(botF015),
        },
        envelope: {
            human_gold: Object.fromEntries(NUMERIC_FEATURES.map((feature) => [
                feature,
                {
                    p10: summarizeGroup(humanGold).numeric[feature].p10,
                    median: summarizeGroup(humanGold).numeric[feature].median,
                    p90: summarizeGroup(humanGold).numeric[feature].p90,
                },
            ])),
        },
        comparisons: {
            human_gold_vs_bot_t001: compareGroupMeans(humanGold, botT001),
            human_gold_vs_bot_f001: compareGroupMeans(humanGold, botF001),
            human_gold_vs_bot_f015: compareGroupMeans(humanGold, botF015),
            human_gold_vs_human_f001: compareGroupMeans(humanGold, humanF001),
        },
        edgeCaseAnalysis,
        references: {
            humanGoldCentroid,
        },
    };
    await writeFile(path.join(outputDir, 'baseline-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('=== Human Baseline Analysis ===');
    console.log(`Human baseline run: ${humanRun}`);
    console.log(`human_gold=${humanGold.length} human_mixed=${humanMixed.length} human_edge_case=${humanEdgeCase.length}`);
    console.log(`bot_t001=${botT001.length} bot_f001=${botF001.length} bot_f015=${botF015.length}`);
    if (edgeCase) {
        console.log(`Edge case: ${edgeCase.runName}/${edgeCase.attemptName} code=${edgeCase.verifyCode}`);
    }
    console.log(`Saved baseline report: ${path.join(outputDir, 'baseline-report.json')}`);
}
await main();
//# sourceMappingURL=analyze-human-bot-baseline.js.map