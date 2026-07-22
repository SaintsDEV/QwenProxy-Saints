#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-data-length')),
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
            const summary = await readJson(path.join(runDir, attempt, 'summary.json'));
            if (!summary)
                continue;
            const param = latestParam(summary);
            const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
            const mode = summary.mode ||
                (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
            rows.push({
                run,
                attempt,
                mode: String(mode || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                dataLength: n(param?.dataLength),
                deviceTokenLength: n(param?.deviceTokenLength),
                target: n(summary.targetDisplayX),
                releaseError: n(summary.releasePositionErrorPx),
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
            });
        }
    }
    return rows.filter((row) => row.dataLength != null);
}
function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function pearson(rows, feature) {
    const pairs = rows
        .map((row) => [row.dataLength, row[feature]])
        .filter((pair) => typeof pair[0] === 'number' && typeof pair[1] === 'number');
    if (pairs.length < 3)
        return null;
    const xs = pairs.map((pair) => pair[0]);
    const ys = pairs.map((pair) => pair[1]);
    const mx = mean(xs);
    const my = mean(ys);
    let numerator = 0;
    let dx2 = 0;
    let dy2 = 0;
    for (let i = 0; i < pairs.length; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        numerator += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    if (dx2 === 0 || dy2 === 0)
        return null;
    return numerator / Math.sqrt(dx2 * dy2);
}
function summarizeGroup(rows) {
    const data = rows.map((row) => row.dataLength).filter((value) => typeof value === 'number');
    return {
        count: rows.length,
        dataLength: data.length
            ? {
                mean: Number(mean(data).toFixed(3)),
                median: Number(median(data).toFixed(3)),
                min: Math.min(...data),
                max: Math.max(...data),
            }
            : null,
    };
}
function groupKey(row) {
    return `${row.mode}_${row.code}`;
}
function csvEscape(value) {
    if (value == null)
        return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(rows) {
    const columns = Object.keys(rows[0] || {});
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const rows = await collectRows(flags.rootDir);
    await mkdir(flags.outputDir, { recursive: true });
    const groups = {};
    for (const key of [...new Set(rows.map(groupKey))].sort()) {
        groups[key] = summarizeGroup(rows.filter((row) => groupKey(row) === key));
    }
    const features = [
        'target',
        'releaseError',
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
    const correlations = features
        .map((feature) => ({
        feature,
        pearson: pearson(rows, feature),
    }))
        .filter((entry) => entry.pearson != null)
        .sort((a, b) => Math.abs(b.pearson || 0) - Math.abs(a.pearson || 0));
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        totalRows: rows.length,
        groups,
        correlations,
        rows,
    };
    await writeFile(path.join(flags.outputDir, 'data-length-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'data-length-rows.csv'), toCsv(rows));
    console.log('=== Data Length Correlation Report ===');
    console.log(`Rows: ${rows.length}`);
    for (const [key, value] of Object.entries(groups)) {
        console.log(`${key}: count=${value.count} dataLengthMedian=${value.dataLength?.median ?? 'n/a'}`);
    }
    console.log('Top correlations:');
    for (const entry of correlations.slice(0, 10)) {
        console.log(`${entry.feature}: ${entry.pearson?.toFixed(4)}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'data-length-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-data-length-correlation.js.map