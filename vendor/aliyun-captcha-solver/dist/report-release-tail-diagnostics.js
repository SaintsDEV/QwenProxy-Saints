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
    const runs = String(flags.runs || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    return {
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || 'isolated-runs')),
        runs: runs.length > 0 ? runs : ['2026-06-19T00-43-03-818Z', '2026-06-19T00-50-06-162Z'],
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-release-tail')),
        humanP90: Number(flags['human-p90'] || 113),
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
    const timeline = summary?.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const length = timeline[i]?.captchaVerifyParamInfo?.dataLength;
        if (typeof length === 'number' && Number.isFinite(length))
            return length;
    }
    return null;
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
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
}
function distance(a, b) {
    if (typeof a?.x !== 'number' || typeof a.y !== 'number' || typeof b?.x !== 'number' || typeof b.y !== 'number') {
        return null;
    }
    return Number(Math.hypot(a.x - b.x, a.y - b.y).toFixed(3));
}
function tailDiagnosis(row, humanP90) {
    if (row.releaseGapMs == null)
        return 'missing_release_gap';
    if (row.releaseGapMs <= humanP90)
        return 'inside_human_release_gap';
    if (row.previousMovePhase === 'track')
        return 'above_human_gap_after_track';
    if (row.previousMovePhase === 'final_hover')
        return 'above_human_gap_after_final_hover';
    if (row.previousMovePhase === 'correction')
        return 'above_human_gap_after_correction';
    return `above_human_gap_after_${row.previousMovePhase || 'unknown'}`;
}
function analyzeTrace(run, attempt, summary, humanP90) {
    const trace = summary.dragResult?.dispatchTrace || [];
    const release = trace.find((event) => event.phase === 'release');
    const movesBeforeRelease = trace.filter((event) => event.cdpType === 'mouseMoved' &&
        (!release || event.seq < release.seq) &&
        event.tsAfter > 0);
    const previousMove = movesBeforeRelease.at(-1);
    const previousPreviousMove = movesBeforeRelease.at(-2);
    const lastFourMoves = movesBeforeRelease.slice(-4);
    const lastThreeMoveGaps = lastFourMoves.slice(1).map((event, index) => {
        const previous = lastFourMoves[index];
        return Math.max(0, event.tsBefore - previous.tsAfter);
    });
    const releaseGap = n(summary.dragResult?.lastMoveToReleaseMs)
        ?? (release && previousMove ? Math.max(0, release.tsBefore - previousMove.tsAfter) : null);
    const baseRow = {
        run,
        attempt,
        mode: String(summary.mode || summary.dragMethod || 'unknown'),
        verifyCode: String(summary.verifyCode || 'n/a'),
        success: !!summary.success,
        visualOutcome: String(summary.visualOutcome?.kind || 'n/a'),
        gestureProfile: String(summary.gestureProfile || 'unknown'),
        preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
        releaseErrorPx: n(summary.releasePositionErrorPx),
        dataLength: latestDataLength(summary),
        releaseGapMs: releaseGap,
        previousMovePhase: String(previousMove?.phase || summary.dragResult?.previousMovePhaseBeforeRelease || 'n/a'),
        previousMovePlannedTrackT: n(previousMove?.plannedTrackT),
        previousMoveDispatchDurationMs: previousMove ? Math.max(0, previousMove.tsAfter - previousMove.tsBefore) : null,
        releaseDispatchDurationMs: release ? Math.max(0, release.tsAfter - release.tsBefore) : null,
        previousMoveToPreviousMoveGapMs: previousMove && previousPreviousMove
            ? Math.max(0, previousMove.tsBefore - previousPreviousMove.tsAfter)
            : null,
        lastThreeMoveGapsMs: lastThreeMoveGaps.map((value) => Number(value.toFixed(3))).join('|'),
        lastThreeMovePhases: movesBeforeRelease.slice(-3).map((event) => event.phase).join('|'),
        lastMoveDistancePx: distance(previousMove, previousPreviousMove),
        traceEvents: trace.length,
        moveEvents: movesBeforeRelease.length,
    };
    return {
        ...baseRow,
        tailDiagnosis: tailDiagnosis(baseRow, humanP90),
    };
}
async function collectRows(rootDir, runs, humanP90) {
    const rows = [];
    for (const run of runs) {
        const runDir = path.join(rootDir, run);
        const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
        const attempts = entries
            .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
            .map((entry) => entry.name)
            .sort();
        for (const attempt of attempts) {
            const summary = await readJson(path.join(runDir, attempt, 'summary.json'));
            if (!summary?.dragResult?.dispatchTrace?.length)
                continue;
            rows.push(analyzeTrace(run, attempt, summary, humanP90));
        }
    }
    return rows;
}
function groupRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${row.run}::${row.verifyCode}::${row.tailDiagnosis}`;
        const group = groups.get(key) || [];
        group.push(row);
        groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
        const [run, verifyCode, tailDiagnosis] = key.split('::');
        return {
            run,
            verifyCode,
            tailDiagnosis,
            attempts: group.length,
            successes: group.filter((row) => row.success).length,
            releaseGapMs: stat(group.map((row) => row.releaseGapMs)),
            previousMoveToPreviousMoveGapMs: stat(group.map((row) => row.previousMoveToPreviousMoveGapMs)),
            previousMoveDispatchDurationMs: stat(group.map((row) => row.previousMoveDispatchDurationMs)),
            releaseDispatchDurationMs: stat(group.map((row) => row.releaseDispatchDurationMs)),
            lastMoveDistancePx: stat(group.map((row) => row.lastMoveDistancePx)),
            dataLength: stat(group.map((row) => row.dataLength)),
        };
    });
}
function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function rowsCsv(rows) {
    const columns = Object.keys(rows[0] || {});
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
}
function statText(value) {
    if (!value)
        return 'n/a';
    return `n=${value.count} med=${value.median} p90=${value.p90}`;
}
function renderMarkdown(report) {
    return [
        '# Release Tail Diagnostics',
        '',
        `- Human release-gap p90 threshold: ${report.humanP90}ms`,
        '',
        '| run | code | diagnosis | attempts | success | releaseGap | prevMoveGap | prevMoveDispatch | releaseDispatch | lastMoveDistance | dataLength |',
        '| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |',
        ...report.groups.map((group) => `| ${group.run} | ${group.verifyCode} | ${group.tailDiagnosis} | ${group.attempts} | ${group.successes} | ${statText(group.releaseGapMs)} | ${statText(group.previousMoveToPreviousMoveGapMs)} | ${statText(group.previousMoveDispatchDurationMs)} | ${statText(group.releaseDispatchDurationMs)} | ${statText(group.lastMoveDistancePx)} | ${statText(group.dataLength)} |`),
        '',
        'Interpretation:',
        '- `above_human_gap_after_track` means the last dispatched movement before release was still a normal track move, then release waited longer than the human p90.',
        '- `prevMoveDispatch` and `releaseDispatch` are CDP call durations, not total gesture timing.',
        '- This report is offline-only and does not alter gesture behavior.',
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const rows = await collectRows(flags.rootDir, flags.runs, flags.humanP90);
    const groups = groupRows(rows);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        runs: flags.runs,
        humanP90: flags.humanP90,
        groups,
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    const jsonPath = path.join(flags.outputDir, 'release-tail-diagnostics.json');
    const csvPath = path.join(flags.outputDir, 'release-tail-diagnostics-rows.csv');
    const mdPath = path.join(flags.outputDir, 'release-tail-diagnostics.md');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(csvPath, rowsCsv(rows), 'utf8');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
    console.log(`Saved: ${mdPath}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-release-tail-diagnostics.js.map