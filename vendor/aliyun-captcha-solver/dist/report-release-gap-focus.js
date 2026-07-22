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
        humanRun: String(flags['human-run'] || '2026-06-17T16-54-19-661Z'),
        runs,
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-release-gap-focus')),
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
        p25: Number(quantile(finite, 0.25).toFixed(3)),
        median: Number(quantile(finite, 0.5).toFixed(3)),
        p75: Number(quantile(finite, 0.75).toFixed(3)),
        p90: Number(quantile(finite, 0.9).toFixed(3)),
        max: Number(Math.max(...finite).toFixed(3)),
    };
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
async function attemptDirs(runDir) {
    const entries = await readdir(runDir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
}
async function collectRunRows(rootDir, run, humanGap) {
    const runDir = path.join(rootDir, run);
    const attempts = await attemptDirs(runDir);
    const rows = [];
    for (const attempt of attempts) {
        const attemptDir = path.join(runDir, attempt);
        const summary = await readJson(path.join(attemptDir, 'summary.json'));
        if (!summary)
            continue;
        const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
        const mode = summary.mode || (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
        const param = latestParam(summary);
        const gap = releaseGap(summary);
        const releaseError = n(summary.releasePositionErrorPx);
        rows.push({
            run,
            attempt,
            mode: String(mode || 'unknown'),
            verifyCode: String(summary.verifyCode || 'n/a'),
            success: !!summary.success,
            gestureProfile: String(summary.gestureProfile || 'unknown'),
            preReleaseCapture: String(summary.preReleaseCapture || 'legacy'),
            releaseGapMs: gap,
            releaseErrorPx: releaseError,
            releaseErrorAbs: releaseError == null ? null : Number(Math.abs(releaseError).toFixed(3)),
            dataLength: n(param?.dataLength),
            deviceTokenLength: n(param?.deviceTokenLength),
            visualOutcome: String(summary.visualOutcome?.kind || 'n/a'),
            environmentFlags: summary.environmentFlags || [],
            gapBand: classifyGap(gap, humanGap),
        });
    }
    return rows;
}
function countBy(items, pick) {
    const counts = {};
    for (const item of items) {
        const key = pick(item);
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
function groupRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${row.run}::${row.mode}::${row.verifyCode}`;
        const group = groups.get(key) || [];
        group.push(row);
        groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
        const [run, mode, verifyCode] = key.split('::');
        return {
            run,
            mode,
            verifyCode,
            attempts: group.length,
            successes: group.filter((row) => row.success).length,
            gap: stat(group.map((row) => row.releaseGapMs)),
            releaseErrorAbs: stat(group.map((row) => row.releaseErrorAbs)),
            dataLength: stat(group.map((row) => row.dataLength)),
            gapBands: countBy(group, (row) => row.gapBand),
            environmentFlags: countBy(group.flatMap((row) => row.environmentFlags), (flag) => flag),
        };
    });
}
function csvEscape(value) {
    const text = Array.isArray(value) ? value.join('|') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function rowsCsv(rows) {
    const columns = [
        'run',
        'attempt',
        'mode',
        'verifyCode',
        'success',
        'gestureProfile',
        'preReleaseCapture',
        'releaseGapMs',
        'releaseErrorPx',
        'releaseErrorAbs',
        'dataLength',
        'deviceTokenLength',
        'visualOutcome',
        'gapBand',
        'environmentFlags',
    ];
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
}
function countsText(counts) {
    const entries = Object.entries(counts);
    if (!entries.length)
        return 'none';
    return entries.map(([key, count]) => `${key}=${count}`).join('; ');
}
function statText(value) {
    if (!value)
        return 'n/a';
    return `n=${value.count} med=${value.median} p10=${value.p10} p90=${value.p90}`;
}
function renderMarkdown(report) {
    return [
        '# Release Gap Focus',
        '',
        `- Human run: ${report.humanRun}`,
        `- Human gold count: ${report.humanGoldCount}`,
        `- Human release-gap envelope: ${statText(report.humanGap)}`,
        '',
        '| run | mode | code | attempts | success | releaseGap | releaseErrAbs | dataLength | gapBands | envFlags |',
        '| --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- |',
        ...report.groups.map((group) => `| ${group.run} | ${group.mode} | ${group.verifyCode} | ${group.attempts} | ${group.successes} | ${statText(group.gap)} | ${statText(group.releaseErrorAbs)} | ${statText(group.dataLength)} | ${countsText(group.gapBands)} | ${countsText(group.environmentFlags)} |`),
        '',
        'Interpretation rules:',
        '- `inside_human_p10_p90` means the release gap falls inside the accepted human middle band.',
        '- `above_human_p90` means the release happened after a longer final idle gap than 90% of accepted human samples.',
        '- This report is diagnostic only; it does not alter gesture behavior or run a captcha attempt.',
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const humanRowsWithoutBands = await collectRunRows(flags.rootDir, flags.humanRun, null);
    const humanGoldRaw = humanRowsWithoutBands.filter((row) => row.mode === 'human' && row.verifyCode === 'T001');
    const humanGap = stat(humanGoldRaw.map((row) => row.releaseGapMs));
    const runs = flags.runs.length > 0 ? flags.runs : ['2026-06-19T00-43-03-818Z', '2026-06-19T00-50-06-162Z'];
    const rows = (await Promise.all(runs.map((run) => collectRunRows(flags.rootDir, run, humanGap)))).flat();
    const humanRows = humanRowsWithoutBands
        .filter((row) => row.mode === 'human')
        .map((row) => ({ ...row, gapBand: classifyGap(row.releaseGapMs, humanGap) }));
    const allRows = [...humanRows, ...rows].sort((a, b) => `${a.run}/${a.attempt}`.localeCompare(`${b.run}/${b.attempt}`));
    const groups = groupRows(rows);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        humanRun: flags.humanRun,
        analyzedRuns: runs,
        humanGoldCount: humanGoldRaw.length,
        humanGap,
        groups,
        rows: allRows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    const jsonPath = path.join(flags.outputDir, 'release-gap-focus.json');
    const csvPath = path.join(flags.outputDir, 'release-gap-focus-rows.csv');
    const mdPath = path.join(flags.outputDir, 'release-gap-focus.md');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(csvPath, rowsCsv(allRows), 'utf8');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
    console.log(`Saved: ${mdPath}`);
    console.log(`Human envelope: ${statText(humanGap)}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-release-gap-focus.js.map