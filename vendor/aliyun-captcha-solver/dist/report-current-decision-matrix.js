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
        .map((run) => run.trim())
        .filter(Boolean);
    return {
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || 'isolated-runs')),
        humanRun: String(flags['human-run'] || '2026-06-17T16-54-19-661Z'),
        runs: runs.length > 0 ? runs : ['2026-06-19T00-43-03-818Z', '2026-06-19T00-50-06-162Z'],
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-current-decision-matrix')),
        geometryThresholdPx: Number(flags['geometry-threshold-px'] || 5),
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
        min: Number(Math.min(...finite).toFixed(3)),
        p10: Number(quantile(finite, 0.1).toFixed(3)),
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
}
async function attemptNames(runDir) {
    const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}
function latestParam(summary) {
    const timeline = summary?.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const info = timeline[i]?.captchaVerifyParamInfo;
        if (info)
            return info;
    }
    return null;
}
function releaseGap(summary) {
    return n(summary?.humanTrajectorySummary?.timeLastMoveToReleaseMs)
        ?? n(summary?.dragResult?.lastMoveToReleaseMs);
}
function finalMoveDistance(summary) {
    const trace = summary?.dragResult?.dispatchTrace || [];
    const release = trace.find((event) => event.phase === 'release');
    const moves = trace.filter((event) => event.cdpType === 'mouseMoved' &&
        (!release || (event.seq || 0) < (release.seq || 0)) &&
        typeof event.x === 'number' &&
        typeof event.y === 'number');
    const a = moves.at(-1);
    const b = moves.at(-2);
    if (!a || !b || typeof a.x !== 'number' || typeof a.y !== 'number' || typeof b.x !== 'number' || typeof b.y !== 'number') {
        return null;
    }
    return Number(Math.hypot(a.x - b.x, a.y - b.y).toFixed(3));
}
function releaseTimingTotal(summary) {
    return n(summary?.dragResult?.releaseTimingBreakdown?.totalMeasuredBeforeReleaseMs);
}
function releaseTimingTopComponent(summary) {
    const breakdown = summary?.dragResult?.releaseTimingBreakdown;
    if (!breakdown)
        return 'n/a';
    const entries = Object.entries(breakdown)
        .filter(([key, value]) => key !== 'totalMeasuredBeforeReleaseMs' && typeof value === 'number' && Number.isFinite(value))
        .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (!entries.length)
        return 'n/a';
    const [name, value] = entries[0];
    return `${name}:${Number(value).toFixed(3)}ms`;
}
function classifyGap(value, humanGap) {
    if (value == null || !humanGap)
        return 'missing';
    if (value < humanGap.p10)
        return 'below_human_p10';
    if (value > humanGap.p90)
        return 'above_human_p90';
    return 'inside_human_p10_p90';
}
function signalFlags(row, geometryThresholdPx) {
    const flags = [];
    if (row.environmentFlags !== 'none')
        flags.push('environment_dirty');
    if (row.code === 'F015')
        flags.push('geometry_or_state_reject');
    if (row.releaseErrorAbs != null && row.releaseErrorAbs > geometryThresholdPx)
        flags.push('geometry_miss');
    if (row.finalMoveDistancePx != null && row.finalMoveDistancePx >= 6)
        flags.push('final_jump_suspect');
    if (row.releaseGapBand === 'above_human_p90')
        flags.push('tail_idle_suspect');
    if (row.code === 'F001' && row.dataLengthDeltaFromCleanT001 != null && row.dataLengthDeltaFromCleanT001 < -80) {
        flags.push('payload_low_suspect');
    }
    if (row.success)
        flags.push('clean_success_reference');
    if (row.code === 'F001' && flags.length === 0)
        flags.push('ambiguous_score_reject');
    return flags;
}
function diagnose(row, geometryThresholdPx) {
    if (row.environmentFlags !== 'none')
        return 'environment_dirty';
    if (row.code === 'F015')
        return 'geometry_or_state_reject';
    if (row.releaseErrorAbs != null && row.releaseErrorAbs > geometryThresholdPx)
        return 'geometry_miss';
    if (row.finalMoveDistancePx != null && row.finalMoveDistancePx >= 6)
        return 'final_jump_suspect';
    if (row.releaseGapBand === 'above_human_p90')
        return 'tail_idle_suspect';
    if (row.code === 'F001' && row.dataLengthDeltaFromCleanT001 != null && row.dataLengthDeltaFromCleanT001 < -80) {
        return 'payload_low_suspect';
    }
    if (row.code === 'F001')
        return 'ambiguous_score_reject';
    if (row.success)
        return 'clean_success_reference';
    return 'unclassified';
}
async function loadAttempt(rootDir, run, attempt) {
    return readJson(path.join(rootDir, run, attempt, 'summary.json'));
}
async function collectHumanGap(rootDir, humanRun) {
    const runDir = path.join(rootDir, humanRun);
    const attempts = await attemptNames(runDir);
    const gaps = [];
    for (const attempt of attempts) {
        const summary = await loadAttempt(rootDir, humanRun, attempt);
        if (summary?.mode === 'human' && summary.verifyCode === 'T001')
            gaps.push(releaseGap(summary));
    }
    return stat(gaps);
}
async function collectRows(rootDir, runs, humanGap, geometryThresholdPx) {
    const rawRows = [];
    for (const run of runs) {
        const attempts = await attemptNames(path.join(rootDir, run));
        for (const attempt of attempts) {
            const summary = await loadAttempt(rootDir, run, attempt);
            if (!summary)
                continue;
            const param = latestParam(summary);
            const gap = releaseGap(summary);
            const releaseError = n(summary.releasePositionErrorPx);
            const environmentFlags = summary.environmentFlags || [];
            rawRows.push({
                run,
                attempt,
                mode: String(summary.mode || summary.dragMethod || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
                visualOutcome: String(summary.visualOutcome?.kind || 'n/a'),
                releaseGapMs: gap,
                releaseGapBand: classifyGap(gap, humanGap),
                releaseErrorPx: releaseError,
                releaseErrorAbs: releaseError == null ? null : Number(Math.abs(releaseError).toFixed(3)),
                dataLength: n(param?.dataLength),
                deviceTokenLength: n(param?.deviceTokenLength),
                gestureDurationMs: n(summary.dragResult?.gestureDurationMs),
                trackPoints: n(summary.dragResult?.trackPoints),
                previousMovePhase: String(summary.dragResult?.previousMovePhaseBeforeRelease || 'n/a'),
                finalMoveDistancePx: finalMoveDistance(summary),
                releaseTimingTotalMs: releaseTimingTotal(summary),
                releaseTimingTopComponent: releaseTimingTopComponent(summary),
                environmentFlags: environmentFlags.length ? environmentFlags.join('|') : 'none',
            });
        }
    }
    const cleanSuccessData = rawRows.filter((row) => row.mode === 'bot' &&
        row.success &&
        row.code === 'T001' &&
        row.preReleaseCapture === 'none' &&
        row.profile === 'direct_fast');
    const successGap = stat(cleanSuccessData.map((row) => row.releaseGapMs));
    const successDataLength = stat(cleanSuccessData.map((row) => row.dataLength));
    return rawRows.map((row) => {
        const withDeltas = {
            ...row,
            releaseGapDeltaFromCleanT001: row.releaseGapMs == null || !successGap
                ? null
                : Number((row.releaseGapMs - successGap.median).toFixed(3)),
            dataLengthDeltaFromCleanT001: row.dataLength == null || !successDataLength
                ? null
                : Number((row.dataLength - successDataLength.median).toFixed(3)),
        };
        const flags = signalFlags(withDeltas, geometryThresholdPx);
        const withSignals = {
            ...withDeltas,
            signalFlags: flags.length ? flags.join(';') : 'none',
        };
        return {
            ...withSignals,
            diagnosis: diagnose(withSignals, geometryThresholdPx),
        };
    });
}
function countBy(items, pick) {
    const counts = {};
    for (const item of items) {
        const key = pick(item);
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
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
    return `n=${value.count} med=${value.median} p10=${value.p10} p90=${value.p90}`;
}
function renderMarkdown(report) {
    return [
        '# Current Decision Matrix',
        '',
        `- Human release-gap envelope: ${statText(report.humanGap)}`,
        `- Geometry threshold: ${report.geometryThresholdPx}px absolute release error`,
        `- Clean bot T001 reference count: ${report.cleanSuccessReference.count}`,
        `- Clean bot T001 release gap: ${statText(report.cleanSuccessReference.releaseGap)}`,
        `- Clean bot T001 dataLength: ${statText(report.cleanSuccessReference.dataLength)}`,
        `- Clean bot T001 release error abs: ${statText(report.cleanSuccessReference.releaseErrorAbs)}`,
        '',
        'Diagnosis counts:',
        ...Object.entries(report.diagnosisCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        'Signal counts:',
        ...Object.entries(report.signalCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '| run | attempt | code | ok | gap | gapBand | dataLength | dDataFromT001 | errAbs | finalMove | env | signals | diagnosis |',
        '| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
        ...report.rows.map((row) => `| ${row.run} | ${row.attempt} | ${row.code} | ${row.success ? 1 : 0} | ${row.releaseGapMs ?? ''} | ${row.releaseGapBand} | ${row.dataLength ?? ''} | ${row.dataLengthDeltaFromCleanT001 ?? ''} | ${row.releaseErrorAbs ?? ''} | ${row.finalMoveDistancePx ?? ''} | ${row.environmentFlags} | ${row.signalFlags} | ${row.diagnosis} |`),
        '',
        'Operational reading:',
        '- `tail_idle_suspect` is a good next test target, not proof of causality.',
        '- `signals` preserves secondary evidence even when the primary diagnosis chooses one bucket.',
        '- `ambiguous_score_reject` means geometry, environment, and release gap are not enough to explain the failure.',
        '- Keep using small clean probes before changing gesture code because the local clean T001 reference has only one sample.',
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const humanGap = await collectHumanGap(flags.rootDir, flags.humanRun);
    const rows = await collectRows(flags.rootDir, flags.runs, humanGap, flags.geometryThresholdPx);
    const cleanSuccessRows = rows.filter((row) => row.mode === 'bot' &&
        row.success &&
        row.code === 'T001' &&
        row.preReleaseCapture === 'none' &&
        row.profile === 'direct_fast');
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        humanRun: flags.humanRun,
        runs: flags.runs,
        geometryThresholdPx: flags.geometryThresholdPx,
        humanGap,
        cleanSuccessReference: {
            count: cleanSuccessRows.length,
            releaseGap: stat(cleanSuccessRows.map((row) => row.releaseGapMs)),
            dataLength: stat(cleanSuccessRows.map((row) => row.dataLength)),
            releaseErrorAbs: stat(cleanSuccessRows.map((row) => row.releaseErrorAbs)),
        },
        diagnosisCounts: countBy(rows, (row) => row.diagnosis),
        signalCounts: countBy(rows.flatMap((row) => row.signalFlags === 'none' ? [] : row.signalFlags.split(';')), (flag) => flag),
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    const jsonPath = path.join(flags.outputDir, 'current-decision-matrix.json');
    const csvPath = path.join(flags.outputDir, 'current-decision-matrix-rows.csv');
    const mdPath = path.join(flags.outputDir, 'current-decision-matrix.md');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(csvPath, rowsCsv(rows), 'utf8');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
    console.log(`Saved: ${mdPath}`);
    console.log(`Diagnosis: ${JSON.stringify(report.diagnosisCounts)}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-current-decision-matrix.js.map