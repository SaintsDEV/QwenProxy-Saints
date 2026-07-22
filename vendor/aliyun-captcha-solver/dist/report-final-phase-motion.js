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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-final-phase-motion')),
        jumpPx: Number(flags['jump-px'] || 6),
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
            const trace = summary?.dragResult?.dispatchTrace || [];
            const release = trace.find((event) => event.phase === 'release');
            if (!summary || !release)
                continue;
            const moves = trace.filter((event) => event.seq < release.seq && event.cdpType === 'mouseMoved');
            const finalMove = moves.at(-1);
            const previousMove = moves.at(-2);
            if (!finalMove || !previousMove)
                continue;
            const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
            const mode = summary.mode || (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
            const dx = finalMove.x - previousMove.x;
            const dy = finalMove.y - previousMove.y;
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
                previousMovePhase: previousMove.phase,
                finalMovePhase: finalMove.phase,
                finalMoveDx: Number(dx.toFixed(3)),
                finalMoveDy: Number(dy.toFixed(3)),
                finalMoveDistancePx: Number(Math.hypot(dx, dy).toFixed(3)),
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
function summarizeGroups(rows, jumpPx) {
    const groups = {};
    for (const key of [...new Set(rows.map(groupKey))].sort()) {
        const groupRows = rows.filter((row) => groupKey(row) === key);
        groups[key] = {
            count: groupRows.length,
            finalMoveDistancePx: stat(groupRows.map((row) => row.finalMoveDistancePx)),
            jumpCount: groupRows.filter((row) => row.finalMoveDistancePx >= jumpPx).length,
            finalMovePhases: groupRows.reduce((acc, row) => {
                acc[row.finalMovePhase] = (acc[row.finalMovePhase] || 0) + 1;
                return acc;
            }, {}),
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
    const jumps = rows
        .filter((row) => row.finalMoveDistancePx >= flags.jumpPx)
        .sort((a, b) => b.finalMoveDistancePx - a.finalMoveDistancePx);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        jumpPx: flags.jumpPx,
        counts: {
            rows: rows.length,
            jumps: jumps.length,
        },
        groups: summarizeGroups(rows, flags.jumpPx),
        jumps,
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'final-phase-motion-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'final-phase-motion-rows.csv'), toCsv(rows));
    console.log('=== Final Phase Motion Report ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Final move jumps >= ${flags.jumpPx}px: ${jumps.length}`);
    console.log('Top 10 final move jumps:');
    for (const row of jumps.slice(0, 10)) {
        console.log(`${row.run}/${row.attempt} ${row.mode} ${row.profile} final=${row.finalAlignMaxMoves} capture=${row.preReleaseCapture} ${row.code} dist=${row.finalMoveDistancePx} dx=${row.finalMoveDx} prev=${row.previousMovePhase} last=${row.finalMovePhase}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'final-phase-motion-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-final-phase-motion.js.map