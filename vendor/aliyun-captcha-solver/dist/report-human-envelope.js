#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const FEATURES = [
    'dataLength',
    'dragDurationMs',
    'moveEvents',
    'dragPausesOver40ms',
    'trackDurationMs',
    'trackPoints',
    'trackMaxStepPx',
    'trackYRange',
    'releaseErrorAbs',
    'totalDy',
    'maxStepPx',
    'negativeDxCount',
    'maxBacktrackPx',
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
        humanRun: String(flags['human-run'] || '2026-06-17T16-54-19-661Z'),
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-human-envelope')),
        bucketSize: Number(flags['bucket-size'] || 20),
        minBucketCount: Number(flags['min-bucket-count'] || 3),
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
function latestDataLength(summary) {
    const timeline = summary.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const length = timeline[i]?.captchaVerifyParamInfo?.dataLength;
        if (typeof length === 'number' && Number.isFinite(length))
            return length;
    }
    return null;
}
function attemptNumber(name) {
    const match = name.match(/\d+/);
    return match ? Number(match[0]) : 0;
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
            const releaseError = n(summary.releasePositionErrorPx);
            rows.push({
                run,
                attempt,
                attemptNumber: attemptNumber(attempt),
                mode: String(mode),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                target: n(summary.targetDisplayX),
                features: {
                    dataLength: latestDataLength(summary),
                    dragDurationMs: n(summary.dragEventSummary?.durationMs),
                    moveEvents: n(summary.dragEventSummary?.moveEvents),
                    dragPausesOver40ms: n(summary.dragEventSummary?.pausesOver40ms),
                    trackDurationMs: n(summary.trackSummary?.durationMs),
                    trackPoints: n(summary.trackSummary?.points),
                    trackMaxStepPx: n(summary.trackSummary?.maxStepPx),
                    trackYRange: n(summary.trackSummary?.yRange),
                    releaseErrorAbs: releaseError == null ? null : Math.abs(releaseError),
                    totalDy: n(summary.dragEventSummary?.totalDy),
                    maxStepPx: n(summary.dragEventSummary?.maxStepPx),
                    negativeDxCount: n(summary.dragEventSummary?.negativeDxCount),
                    maxBacktrackPx: n(summary.dragEventSummary?.maxBacktrackPx),
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
    if (values.length === 0)
        return null;
    return {
        count: values.length,
        min: Number(Math.min(...values).toFixed(3)),
        p10: Number(quantile(values, 0.1).toFixed(3)),
        median: Number(quantile(values, 0.5).toFixed(3)),
        p90: Number(quantile(values, 0.9).toFixed(3)),
        max: Number(Math.max(...values).toFixed(3)),
    };
}
function bucketForTarget(target, bucketSize) {
    const min = Math.floor(target / bucketSize) * bucketSize;
    return `${min}-${min + bucketSize - 1}`;
}
function bucketBounds(bucket) {
    const [min, max] = bucket.split('-').map(Number);
    return { min, max };
}
function buildEnvelope(rows, bucketSize, minBucketCount) {
    const globalRows = rows.filter((row) => row.target != null);
    const buckets = new Map();
    for (const row of globalRows) {
        const bucket = bucketForTarget(row.target, bucketSize);
        buckets.set(bucket, [...(buckets.get(bucket) || []), row]);
    }
    const globalStats = {};
    for (const feature of FEATURES) {
        const values = globalRows
            .map((row) => row.features[feature])
            .filter((value) => typeof value === 'number');
        const featureStat = stat(values);
        if (featureStat)
            globalStats[feature] = featureStat;
    }
    const envelopes = new Map();
    for (const [bucket, bucketRows] of buckets) {
        const { min, max } = bucketBounds(bucket);
        const stats = {};
        for (const feature of FEATURES) {
            const sourceRows = bucketRows.length >= minBucketCount ? bucketRows : globalRows;
            const values = sourceRows
                .map((row) => row.features[feature])
                .filter((value) => typeof value === 'number');
            const featureStat = stat(values);
            if (featureStat)
                stats[feature] = featureStat;
        }
        envelopes.set(bucket, {
            bucket,
            targetMin: min,
            targetMax: max,
            count: bucketRows.length,
            stats,
        });
    }
    return {
        global: {
            bucket: 'global',
            targetMin: Number.NEGATIVE_INFINITY,
            targetMax: Number.POSITIVE_INFINITY,
            count: globalRows.length,
            stats: globalStats,
        },
        buckets: envelopes,
    };
}
function classify(value, statValue) {
    if (value < statValue.p10)
        return 'below';
    if (value > statValue.p90)
        return 'above';
    return 'inside';
}
function deviationScore(value, statValue) {
    const spread = Math.max(statValue.p90 - statValue.p10, 1);
    if (value < statValue.p10)
        return (statValue.p10 - value) / spread;
    if (value > statValue.p90)
        return (value - statValue.p90) / spread;
    return 0;
}
function evaluateAgainstEnvelope(row, envelope) {
    const deviations = FEATURES.flatMap((feature) => {
        const value = row.features[feature];
        const featureStat = envelope.stats[feature];
        if (typeof value !== 'number' || !featureStat)
            return [];
        const status = classify(value, featureStat);
        const score = deviationScore(value, featureStat);
        if (status === 'inside')
            return [];
        return [{
                feature,
                value: Number(value.toFixed(3)),
                status,
                p10: featureStat.p10,
                median: featureStat.median,
                p90: featureStat.p90,
                score: Number(score.toFixed(3)),
            }];
    }).sort((a, b) => b.score - a.score);
    return {
        run: row.run,
        attempt: row.attempt,
        mode: row.mode,
        code: row.code,
        success: row.success,
        profile: row.profile,
        target: row.target,
        bucket: envelope.bucket,
        outsideCount: deviations.length,
        score: Number(deviations.reduce((sum, item) => sum + item.score, 0).toFixed(3)),
        topDeviations: deviations.slice(0, 8),
    };
}
function csvEscape(value) {
    if (value == null)
        return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows) {
    const columns = ['run', 'attempt', 'mode', 'code', 'success', 'profile', 'target', 'bucket', 'outsideCount', 'score', 'topDeviations'];
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const rows = await collectRows(flags.rootDir);
    const humanGold = rows.filter((row) => row.run === flags.humanRun && row.mode === 'human' && row.code === 'T001');
    const envelope = buildEnvelope(humanGold, flags.bucketSize, flags.minBucketCount);
    const evaluated = rows
        .filter((row) => row.mode === 'bot' && row.target != null)
        .map((row) => {
        const bucket = bucketForTarget(row.target, flags.bucketSize);
        return evaluateAgainstEnvelope(row, envelope.buckets.get(bucket) || envelope.global);
    })
        .sort((a, b) => b.score - a.score);
    const byCode = {};
    for (const code of [...new Set(evaluated.map((row) => row.code))].sort()) {
        const codeRows = evaluated.filter((row) => row.code === code);
        byCode[code] = {
            count: codeRows.length,
            medianScore: Number(quantile(codeRows.map((row) => row.score), 0.5).toFixed(3)),
            medianOutsideCount: Number(quantile(codeRows.map((row) => row.outsideCount), 0.5).toFixed(3)),
        };
    }
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        humanRun: flags.humanRun,
        bucketSize: flags.bucketSize,
        minBucketCount: flags.minBucketCount,
        humanGoldCount: humanGold.length,
        byCode,
        envelope: {
            global: envelope.global,
            buckets: [...envelope.buckets.values()].sort((a, b) => a.targetMin - b.targetMin),
        },
        evaluated,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'human-envelope-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'bot-envelope-deviations.csv'), toCsv(evaluated));
    console.log('=== Human Envelope Report ===');
    console.log(`Human gold: ${humanGold.length}`);
    for (const [code, stats] of Object.entries(byCode)) {
        console.log(`${code}: count=${stats.count} medianScore=${stats.medianScore} medianOutside=${stats.medianOutsideCount}`);
    }
    console.log('Top 10 bot deviations:');
    for (const row of evaluated.slice(0, 10)) {
        console.log(`${row.run}/${row.attempt} ${row.code} target=${row.target} score=${row.score} top=${row.topDeviations.map((item) => `${item.feature}:${item.status}`).join('|')}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'human-envelope-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-human-envelope.js.map