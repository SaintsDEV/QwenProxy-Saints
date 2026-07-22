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
        humanRun: String(flags['human-run'] || '2026-06-17T16-54-19-661Z'),
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-release-timing')),
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
function dispatchLastMoveToRelease(trace) {
    if (!Array.isArray(trace))
        return null;
    const release = trace.find((event) => event.phase === 'release');
    if (!release)
        return null;
    const previous = trace
        .filter((event) => event.seq < release.seq && event.cdpType === 'mouseMoved' && event.tsAfter > 0)
        .at(-1);
    if (!previous)
        return null;
    return Math.max(0, release.tsBefore - previous.tsAfter);
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
            const humanValue = n(summary.humanTrajectorySummary?.timeLastMoveToReleaseMs);
            const dragResultValue = n(summary.dragResult?.lastMoveToReleaseMs);
            const dispatchValue = dispatchLastMoveToRelease(summary.dragResult?.dispatchTrace);
            const lastMoveToReleaseMs = humanValue ?? dragResultValue ?? dispatchValue;
            rows.push({
                run,
                attempt,
                mode: String(mode || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                finalAlignMaxMoves: n(summary.gestureTuning?.finalAlignMaxMoves),
                preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
                target: n(summary.targetDisplayX),
                releaseError: n(summary.releasePositionErrorPx),
                lastMoveToReleaseMs,
                source: humanValue != null
                    ? 'humanTrajectory'
                    : dragResultValue != null
                        ? 'dragResult'
                        : dispatchValue != null
                            ? 'dispatchTrace'
                            : 'missing',
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
    if (!finite.length)
        return null;
    return {
        count: finite.length,
        min: Number(Math.min(...finite).toFixed(3)),
        p10: Number(quantile(finite, 0.1).toFixed(3)),
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
}
function groupKey(row) {
    return `${row.mode}_${row.profile}_final${row.finalAlignMaxMoves ?? 'n/a'}_${row.preReleaseCapture}_${row.code}`;
}
function summarizeGroups(rows) {
    const groups = {};
    for (const key of [...new Set(rows.map(groupKey))].sort()) {
        const groupRows = rows.filter((row) => groupKey(row) === key);
        groups[key] = {
            count: groupRows.length,
            sourceCounts: groupRows.reduce((acc, row) => {
                acc[row.source] = (acc[row.source] || 0) + 1;
                return acc;
            }, {}),
            lastMoveToReleaseMs: stat(groupRows.map((row) => row.lastMoveToReleaseMs)),
        };
    }
    return groups;
}
function csvEscape(value) {
    if (value == null)
        return '';
    const text = typeof value === 'string' ? value : String(value);
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
    const humanGold = rows.filter((row) => row.run === flags.humanRun && row.mode === 'human' && row.code === 'T001');
    const humanGoldStat = stat(humanGold.map((row) => row.lastMoveToReleaseMs));
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        humanRun: flags.humanRun,
        counts: {
            rows: rows.length,
            humanGold: humanGold.length,
        },
        humanGoldEnvelope: humanGoldStat,
        groups: summarizeGroups(rows),
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'release-timing-envelope-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'release-timing-envelope-rows.csv'), toCsv(rows));
    console.log('=== Release Timing Envelope Report ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Human gold: ${humanGold.length}`);
    console.log(`Human gold lastMoveToReleaseMs: median=${humanGoldStat?.median ?? 'n/a'} p10=${humanGoldStat?.p10 ?? 'n/a'} p90=${humanGoldStat?.p90 ?? 'n/a'}`);
    for (const [key, value] of Object.entries(report.groups).filter(([key]) => key.includes('bot_direct_fast_final0_legacy')).sort()) {
        const stats = value.lastMoveToReleaseMs;
        console.log(`${key}: count=${value.count} median=${stats?.median ?? 'n/a'} p90=${stats?.p90 ?? 'n/a'}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'release-timing-envelope-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-release-timing-envelope.js.map