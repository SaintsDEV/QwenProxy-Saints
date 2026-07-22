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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-release-gap')),
        longGapMs: Number(flags['long-gap-ms'] || 120),
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
            const trace = summary.dragResult?.dispatchTrace || [];
            const release = trace.find((event) => event.phase === 'release');
            if (!release)
                continue;
            const previous = trace
                .filter((event) => event.seq < release.seq && typeof event.tsAfter === 'number' && event.tsAfter > 0)
                .at(-1);
            if (!previous)
                continue;
            const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
            const mode = summary.mode || (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
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
                dataLength: latestDataLength(summary),
                prevPhase: previous.phase,
                prevType: previous.cdpType,
                releaseHoldGapMs: Math.max(0, release.tsBefore - previous.tsAfter),
                releaseDispatchCallMs: Math.max(0, release.tsAfter - release.tsBefore),
                finalPhaseDispatchDegraded: !!summary.dragResult?.finalPhaseDispatchDegraded,
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
    const finite = values.filter((value) => Number.isFinite(value));
    if (!finite.length)
        return null;
    return {
        count: finite.length,
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
}
function groupKey(row) {
    return `${row.mode}_${row.profile}_final${row.finalAlignMaxMoves ?? 'n/a'}_${row.preReleaseCapture}_${row.code}`;
}
function phaseCounts(rows) {
    const counts = {};
    for (const row of rows) {
        counts[row.prevPhase] = (counts[row.prevPhase] || 0) + 1;
    }
    return counts;
}
function summarizeGroups(rows, longGapMs) {
    const groups = {};
    for (const key of [...new Set(rows.map(groupKey))].sort()) {
        const groupRows = rows.filter((row) => groupKey(row) === key);
        groups[key] = {
            count: groupRows.length,
            releaseHoldGapMs: stat(groupRows.map((row) => row.releaseHoldGapMs)),
            releaseDispatchCallMs: stat(groupRows.map((row) => row.releaseDispatchCallMs)),
            longGapCount: groupRows.filter((row) => row.releaseHoldGapMs >= longGapMs).length,
            previousPhaseCounts: phaseCounts(groupRows),
            degradedCount: groupRows.filter((row) => row.finalPhaseDispatchDegraded).length,
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
    const longGaps = rows.filter((row) => row.releaseHoldGapMs >= flags.longGapMs)
        .sort((a, b) => b.releaseHoldGapMs - a.releaseHoldGapMs);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        longGapMs: flags.longGapMs,
        counts: {
            rows: rows.length,
            longGaps: longGaps.length,
            byPreReleaseCapture: rows.reduce((acc, row) => {
                acc[row.preReleaseCapture] = (acc[row.preReleaseCapture] || 0) + 1;
                return acc;
            }, {}),
        },
        groups: summarizeGroups(rows, flags.longGapMs),
        longGaps,
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'release-hold-gap-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'release-hold-gap-rows.csv'), toCsv(rows));
    console.log('=== Release Hold Gap Report ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Long gaps >= ${flags.longGapMs}ms: ${longGaps.length}`);
    console.log('Top 10 long gaps:');
    for (const row of longGaps.slice(0, 10)) {
        console.log(`${row.run}/${row.attempt} ${row.mode} ${row.profile} final=${row.finalAlignMaxMoves} capture=${row.preReleaseCapture} ${row.code} gap=${row.releaseHoldGapMs} prev=${row.prevPhase} releaseCall=${row.releaseDispatchCallMs}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'release-hold-gap-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-release-hold-gap.js.map