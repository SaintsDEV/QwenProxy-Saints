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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-dataset-health')),
        releaseErrorPx: Number(flags['release-error-px'] || 5),
        finalJumpPx: Number(flags['final-jump-px'] || 6),
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
        p10: Number(quantile(finite, 0.1).toFixed(3)),
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
    };
}
function latestCaptchaParam(summary) {
    const timeline = summary.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const info = timeline[i]?.captchaVerifyParamInfo;
        if (info)
            return info;
    }
    return null;
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
    return previous ? Math.max(0, release.tsBefore - previous.tsAfter) : null;
}
function finalMoveDistance(trace) {
    if (!Array.isArray(trace))
        return null;
    const release = trace.find((event) => event.phase === 'release');
    if (!release)
        return null;
    const moves = trace.filter((event) => event.seq < release.seq && event.cdpType === 'mouseMoved');
    const last = moves.at(-1);
    const previous = moves.at(-2);
    if (typeof last?.x !== 'number' ||
        typeof last.y !== 'number' ||
        typeof previous?.x !== 'number' ||
        typeof previous.y !== 'number') {
        return null;
    }
    return Number(Math.hypot(last.x - previous.x, last.y - previous.y).toFixed(3));
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
            const humanReleaseTiming = n(summary.humanTrajectorySummary?.timeLastMoveToReleaseMs);
            const dragReleaseTiming = n(summary.dragResult?.lastMoveToReleaseMs);
            const dispatchReleaseTiming = dispatchLastMoveToRelease(summary.dragResult?.dispatchTrace);
            const param = latestCaptchaParam(summary);
            rows.push({
                run,
                attempt,
                attemptDir,
                mode: String(mode || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                finalAlignMaxMoves: n(summary.gestureTuning?.finalAlignMaxMoves),
                preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
                target: n(summary.targetDisplayX),
                releaseErrorAbs: releaseError == null ? null : Math.abs(releaseError),
                lastMoveToReleaseMs: humanReleaseTiming ?? dragReleaseTiming ?? dispatchReleaseTiming,
                finalMoveDistancePx: finalMoveDistance(summary.dragResult?.dispatchTrace),
                dataLength: n(param?.dataLength),
                deviceTokenLength: n(param?.deviceTokenLength),
            });
        }
    }
    return rows;
}
function classifyRow(row, humanTimingP90, releaseErrorPx, finalJumpPx) {
    const flags = [];
    if (row.mode === 'bot' && row.preReleaseCapture === 'legacy') {
        flags.push('legacy_pre_release_capture');
    }
    if (row.mode === 'bot' && typeof row.lastMoveToReleaseMs === 'number' && row.lastMoveToReleaseMs > humanTimingP90) {
        flags.push('release_timing_above_human_p90');
    }
    if (row.mode === 'bot' && row.lastMoveToReleaseMs == null) {
        flags.push('missing_release_timing');
    }
    if (typeof row.finalMoveDistancePx === 'number' && row.finalMoveDistancePx >= finalJumpPx) {
        flags.push('final_move_jump');
    }
    if (typeof row.releaseErrorAbs === 'number' && row.releaseErrorAbs > releaseErrorPx) {
        flags.push('release_error_high');
    }
    if (row.dataLength == null && row.code !== 'n/a') {
        flags.push('missing_captcha_param');
    }
    if (row.code === 'n/a') {
        flags.push('no_decisive_verify_code');
    }
    if (row.mode === 'human' && row.code !== 'T001') {
        flags.push('human_edge_case');
    }
    let healthClass;
    if (row.mode === 'human' && row.code === 'T001') {
        healthClass = 'human_gold';
    }
    else if (row.mode === 'human') {
        healthClass = 'human_edge';
    }
    else if (row.code === 'n/a' || flags.includes('missing_release_timing')) {
        healthClass = 'invalid_or_incomplete';
    }
    else if (row.preReleaseCapture === 'none' && !flags.some((flag) => flag !== 'missing_captcha_param')) {
        healthClass = 'clean_candidate';
    }
    else {
        healthClass = 'diagnostic_only';
    }
    return { ...row, flags, healthClass };
}
function countBy(rows, keyFn) {
    return rows.reduce((acc, row) => {
        const key = keyFn(row);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}
function csvEscape(value) {
    if (value == null)
        return '';
    const text = Array.isArray(value) ? value.join('|') : String(value);
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
    const rawRows = await collectRows(flags.rootDir);
    const humanGoldRaw = rawRows.filter((row) => row.run === flags.humanRun && row.mode === 'human' && row.code === 'T001');
    const humanTiming = stat(humanGoldRaw.map((row) => row.lastMoveToReleaseMs));
    const humanTimingP90 = humanTiming?.p90 ?? 120;
    const rows = rawRows
        .map((row) => classifyRow(row, humanTimingP90, flags.releaseErrorPx, flags.finalJumpPx))
        .sort((a, b) => `${a.run}/${a.attempt}`.localeCompare(`${b.run}/${b.attempt}`));
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        humanRun: flags.humanRun,
        thresholds: {
            humanTimingP90,
            releaseErrorPx: flags.releaseErrorPx,
            finalJumpPx: flags.finalJumpPx,
        },
        humanTimingEnvelope: humanTiming,
        counts: {
            total: rows.length,
            byHealthClass: countBy(rows, (row) => row.healthClass),
            byModeCode: countBy(rows, (row) => `${row.mode}_${row.code}`),
            byPreReleaseCapture: countBy(rows, (row) => row.preReleaseCapture),
            byFlag: rows.reduce((acc, row) => {
                for (const flag of row.flags) {
                    acc[flag] = (acc[flag] || 0) + 1;
                }
                return acc;
            }, {}),
        },
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'dataset-health-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'dataset-health-rows.csv'), toCsv(rows));
    console.log('=== Dataset Health Report ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Human timing p90: ${humanTimingP90}ms`);
    console.log('Health classes:');
    for (const [key, count] of Object.entries(report.counts.byHealthClass).sort()) {
        console.log(`${key}: ${count}`);
    }
    console.log('Top flags:');
    for (const [key, count] of Object.entries(report.counts.byFlag).sort((a, b) => b[1] - a[1])) {
        console.log(`${key}: ${count}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'dataset-health-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-dataset-health.js.map