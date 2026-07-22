#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const FEATURES = [
    'dataLength',
    'deviceTokenLength',
    'target',
    'releaseErrorAbs',
    'dragDurationMs',
    'moveEvents',
    'totalDx',
    'totalDy',
    'maxStepPx',
    'negativeDxCount',
    'maxBacktrackPx',
    'dragPausesOver40ms',
    'trackPoints',
    'trackDurationMs',
    'trackMaxStepPx',
    'trackYRange',
    'trackPausesOver40ms',
    'dispatchAvgLagMs',
    'dispatchMaxLagMs',
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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-bot-outcomes')),
        profile: String(flags.profile || 'direct_fast'),
        sinceRun: flags['since-run'] ? String(flags['since-run']) : null,
        finalAlignMaxMoves: flags['final-align-max-moves'] == null ? null : Number(flags['final-align-max-moves']),
        preReleaseCapture: flags['pre-release-capture'] == null ? null : String(flags['pre-release-capture']),
        maxReleaseError: Number(flags['max-release-error'] || 5),
    };
}
async function readJson(filePath) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function n(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function latestParam(summary) {
    const timeline = summary.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const info = timeline[i]?.captchaVerifyParamInfo;
        if (info)
            return info;
    }
    return null;
}
async function collectRows(rootDir) {
    const runs = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const runEntry of runs) {
        if (!runEntry.isDirectory())
            continue;
        const run = runEntry.name;
        const runDir = path.join(rootDir, run);
        const attempts = await readdir(runDir, { withFileTypes: true }).catch(() => []);
        for (const attemptEntry of attempts) {
            if (!attemptEntry.isDirectory())
                continue;
            const attempt = attemptEntry.name;
            const attemptDir = path.join(runDir, attempt);
            const summary = await readJson(path.join(attemptDir, 'summary.json'));
            if (!summary)
                continue;
            const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
            const mode = summary.mode || (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
            const param = latestParam(summary);
            const releaseError = n(summary.releasePositionErrorPx);
            rows.push({
                run,
                attempt,
                mode: String(mode || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
                finalAlignMaxMoves: n(summary.gestureTuning?.finalAlignMaxMoves),
                features: {
                    dataLength: n(param?.dataLength),
                    deviceTokenLength: n(param?.deviceTokenLength),
                    target: n(summary.targetDisplayX),
                    releaseErrorAbs: releaseError == null ? null : Math.abs(releaseError),
                    dragDurationMs: n(summary.dragEventSummary?.durationMs),
                    moveEvents: n(summary.dragEventSummary?.moveEvents),
                    totalDx: n(summary.dragEventSummary?.totalDx),
                    totalDy: n(summary.dragEventSummary?.totalDy),
                    maxStepPx: n(summary.dragEventSummary?.maxStepPx),
                    negativeDxCount: n(summary.dragEventSummary?.negativeDxCount),
                    maxBacktrackPx: n(summary.dragEventSummary?.maxBacktrackPx),
                    dragPausesOver40ms: n(summary.dragEventSummary?.pausesOver40ms),
                    trackPoints: n(summary.trackSummary?.points),
                    trackDurationMs: n(summary.trackSummary?.durationMs),
                    trackMaxStepPx: n(summary.trackSummary?.maxStepPx),
                    trackYRange: n(summary.trackSummary?.yRange),
                    trackPausesOver40ms: n(summary.trackSummary?.pausesOver40ms),
                    dispatchAvgLagMs: n(summary.dispatchVsDom?.avgLagMs),
                    dispatchMaxLagMs: n(summary.dispatchVsDom?.maxLagMs),
                },
            });
        }
    }
    return rows;
}
function quantile(values, ratio) {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const index = (sorted.length - 1) * ratio;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}
function stat(values) {
    const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (finite.length === 0)
        return null;
    const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
    return {
        count: finite.length,
        mean: Number(mean.toFixed(3)),
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p10: Number(quantile(finite, 0.1).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        min: Number(Math.min(...finite).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
}
function groupStats(rows) {
    const stats = {};
    for (const feature of FEATURES) {
        const featureStat = stat(rows.map((row) => row.features[feature]));
        if (featureStat)
            stats[feature] = featureStat;
    }
    return stats;
}
function medianDelta(left, right) {
    return FEATURES.flatMap((feature) => {
        const leftStat = left[feature];
        const rightStat = right[feature];
        if (!leftStat || !rightStat)
            return [];
        return [{
                feature,
                leftMedian: leftStat.median,
                rightMedian: rightStat.median,
                delta: Number((rightStat.median - leftStat.median).toFixed(3)),
            }];
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
function featureDistance(a, b, stats) {
    let distance = 0;
    let count = 0;
    for (const feature of FEATURES) {
        if (feature === 'dataLength' || feature === 'deviceTokenLength')
            continue;
        const av = a.features[feature];
        const bv = b.features[feature];
        const featureStat = stats[feature];
        if (typeof av !== 'number' || typeof bv !== 'number' || !featureStat)
            continue;
        const scale = Math.max(featureStat.p90 - featureStat.p10, 1);
        distance += Math.abs(av - bv) / scale;
        count++;
    }
    return count ? Number((distance / count).toFixed(4)) : Number.POSITIVE_INFINITY;
}
function nearestSuccessRows(rows) {
    const t001 = rows.filter((row) => row.code === 'T001');
    const stats = groupStats(rows);
    return rows
        .filter((row) => row.code === 'F001' || row.code === 'F015')
        .flatMap((row) => {
        const candidates = t001
            .map((successRow) => ({
            successRow,
            distance: featureDistance(row, successRow, stats),
            targetDelta: targetDelta(row, successRow),
        }))
            .filter((candidate) => Number.isFinite(candidate.distance))
            .sort((a, b) => a.distance - b.distance || Math.abs(a.targetDelta) - Math.abs(b.targetDelta));
        const nearest = candidates[0];
        if (!nearest)
            return [];
        return [{
                run: row.run,
                attempt: row.attempt,
                code: row.code,
                target: row.features.target,
                nearestT001: `${nearest.successRow.run}/${nearest.successRow.attempt}`,
                nearestT001Target: nearest.successRow.features.target,
                targetDelta: nearest.targetDelta,
                distance: nearest.distance,
                dataLengthDelta: diff(row.features.dataLength, nearest.successRow.features.dataLength),
                trackMaxStepDelta: diff(row.features.trackMaxStepPx, nearest.successRow.features.trackMaxStepPx),
                trackDurationDelta: diff(row.features.trackDurationMs, nearest.successRow.features.trackDurationMs),
                moveEventsDelta: diff(row.features.moveEvents, nearest.successRow.features.moveEvents),
                releaseErrorDelta: diff(row.features.releaseErrorAbs, nearest.successRow.features.releaseErrorAbs),
            }];
    })
        .sort((a, b) => a.distance - b.distance);
}
function diff(left, right) {
    if (typeof left !== 'number' || typeof right !== 'number')
        return null;
    return Number((left - right).toFixed(3));
}
function targetDelta(left, right) {
    return diff(left.features.target, right.features.target) ?? Number.POSITIVE_INFINITY;
}
function csvEscape(value) {
    if (value == null)
        return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows) {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const rows = await collectRows(flags.rootDir);
    const comparable = rows
        .filter((row) => row.mode === 'bot')
        .filter((row) => row.profile === flags.profile)
        .filter((row) => flags.finalAlignMaxMoves == null || row.finalAlignMaxMoves === flags.finalAlignMaxMoves)
        .filter((row) => flags.preReleaseCapture == null || row.preReleaseCapture === flags.preReleaseCapture)
        .filter((row) => !flags.sinceRun || row.run >= flags.sinceRun)
        .filter((row) => row.features.dataLength != null)
        .filter((row) => row.features.target != null)
        .filter((row) => row.code === 'T001' || row.code === 'F001' || row.code === 'F015');
    const aligned = comparable.filter((row) => {
        const releaseError = row.features.releaseErrorAbs;
        return typeof releaseError === 'number' && releaseError <= flags.maxReleaseError;
    });
    const groups = {};
    for (const code of ['T001', 'F001', 'F015']) {
        const codeRows = comparable.filter((row) => row.code === code);
        groups[`all_${code}`] = { count: codeRows.length, stats: groupStats(codeRows) };
        const alignedRows = aligned.filter((row) => row.code === code);
        groups[`aligned_${code}`] = { count: alignedRows.length, stats: groupStats(alignedRows) };
    }
    const t001Stats = groupStats(aligned.filter((row) => row.code === 'T001'));
    const deltas = {
        alignedF001MinusT001: medianDelta(t001Stats, groupStats(aligned.filter((row) => row.code === 'F001'))),
        alignedF015MinusT001: medianDelta(t001Stats, groupStats(aligned.filter((row) => row.code === 'F015'))),
    };
    const nearest = nearestSuccessRows(aligned);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        filters: {
            profile: flags.profile,
            sinceRun: flags.sinceRun,
            finalAlignMaxMoves: flags.finalAlignMaxMoves,
            preReleaseCapture: flags.preReleaseCapture,
            maxReleaseError: flags.maxReleaseError,
        },
        counts: {
            comparable: comparable.length,
            aligned: aligned.length,
        },
        groups,
        deltas,
        nearest,
        rows: comparable,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'bot-outcome-comparison.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'bot-nearest-t001.csv'), toCsv(nearest));
    console.log('=== Bot Outcome Comparison ===');
    console.log(`Profile: ${flags.profile}`);
    if (flags.finalAlignMaxMoves != null) {
        console.log(`finalAlignMaxMoves: ${flags.finalAlignMaxMoves}`);
    }
    if (flags.preReleaseCapture != null) {
        console.log(`preReleaseCapture: ${flags.preReleaseCapture}`);
    }
    console.log(`Comparable rows: ${comparable.length}`);
    console.log(`Aligned rows (releaseError <= ${flags.maxReleaseError}px): ${aligned.length}`);
    for (const key of Object.keys(groups)) {
        const group = groups[key];
        const dataLength = group.stats.dataLength?.median ?? 'n/a';
        const trackStep = group.stats.trackMaxStepPx?.median ?? 'n/a';
        const releaseError = group.stats.releaseErrorAbs?.median ?? 'n/a';
        console.log(`${key}: count=${group.count} dataLengthMedian=${dataLength} trackMaxStepMedian=${trackStep} releaseErrorMedian=${releaseError}`);
    }
    console.log('Top aligned F001 - T001 median deltas:');
    for (const item of deltas.alignedF001MinusT001.slice(0, 8)) {
        console.log(`${item.feature}: ${item.delta}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'bot-outcome-comparison.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-bot-outcome-comparison.js.map