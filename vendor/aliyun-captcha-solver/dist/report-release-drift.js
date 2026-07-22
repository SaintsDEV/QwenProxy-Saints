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
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-release-drift')),
        jumpThresholdPx: Number(flags['jump-threshold-px'] || 2),
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
function parsePx(value) {
    if (typeof value !== 'string')
        return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function element(snapshot, key) {
    return snapshot?.context?.page?.elements?.[key] || null;
}
function rectX(snapshot, key) {
    return n(element(snapshot, key)?.rect?.x);
}
function visible(snapshot, key) {
    const value = element(snapshot, key)?.visible;
    return typeof value === 'boolean' ? value : null;
}
function delta(left, right) {
    if (typeof left !== 'number' || typeof right !== 'number')
        return null;
    return Number((right - left).toFixed(3));
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
            const pre = await readJson(path.join(attemptDir, 'pre-release-state.json'));
            const release = await readJson(path.join(attemptDir, 'release-state.json'));
            const post = await readJson(path.join(attemptDir, 'post-wait-state.json'));
            const timeline = await readJson(path.join(attemptDir, 'release-timeline.json'));
            if (!release)
                continue;
            const hasHumanTrajectory = await readJson(path.join(attemptDir, 'human-trajectory.json'));
            const mode = summary.mode || (summary.dragMethod === 'human' || hasHumanTrajectory ? 'human' : 'bot');
            const releaseImageBoxX = rectX(release, 'imageBox');
            const preLivePuzzleLeft = n(release.dragResult?.preReleaseLivePosition?.puzzleLeft);
            const preLiveSliderLeft = n(release.dragResult?.preReleaseLivePosition?.sliderLeft);
            const prePuzzleX = rectX(pre, 'puzzle') ??
                (typeof releaseImageBoxX === 'number' && typeof preLivePuzzleLeft === 'number'
                    ? Number((releaseImageBoxX + preLivePuzzleLeft).toFixed(3))
                    : null);
            const releasePuzzleX = rectX(release, 'puzzle');
            const postPuzzleX = rectX(post, 'puzzle');
            const postImageBoxX = rectX(post, 'imageBox');
            const exactPuzzleLeft = parsePx(timeline?.exact?.puzzleLeft);
            const latestPuzzleLeft = parsePx(timeline?.latest?.puzzleLeft);
            const exactSliderLeft = parsePx(timeline?.exact?.sliderLeft);
            const latestSliderLeft = parsePx(timeline?.latest?.sliderLeft);
            rows.push({
                run,
                attempt,
                mode: String(mode || 'unknown'),
                code: String(summary.verifyCode || 'n/a'),
                success: !!summary.success,
                profile: String(summary.gestureProfile || 'unknown'),
                finalAlignMaxMoves: n(summary.gestureTuning?.finalAlignMaxMoves),
                target: n(summary.targetDisplayX),
                releaseError: n(summary.releasePositionErrorPx),
                settledReleaseError: n(summary.releaseSettledPositionErrorPx),
                captureLagMs: n(timeline?.captureLagMs),
                prePuzzleX,
                releasePuzzleX,
                postPuzzleX,
                postImageBoxX,
                preSliderX: rectX(pre, 'slider') ?? preLiveSliderLeft,
                releaseSliderX: rectX(release, 'slider'),
                postSliderX: rectX(post, 'slider'),
                postSliderVisible: visible(post, 'slider'),
                exactPuzzleLeft,
                latestPuzzleLeft,
                exactSliderLeft,
                latestSliderLeft,
                preToReleasePuzzleDelta: delta(prePuzzleX, releasePuzzleX),
                releaseToPostPuzzleDelta: delta(releasePuzzleX, postPuzzleX),
                exactToLatestPuzzleDelta: delta(exactPuzzleLeft, latestPuzzleLeft),
                exactToLatestSliderDelta: delta(exactSliderLeft, latestSliderLeft),
                postOutcomeReset: typeof postPuzzleX === 'number' &&
                    typeof postImageBoxX === 'number' &&
                    Math.abs(postPuzzleX - postImageBoxX) <= 1,
                preReleaseSource: rectX(pre, 'puzzle') != null
                    ? 'snapshot'
                    : preLivePuzzleLeft != null
                        ? 'dragResult'
                        : 'missing',
                statusText: element(post, 'window')?.text || '',
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
function absStat(values) {
    const finite = values
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
        .map((value) => Math.abs(value));
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
    return `${row.mode}_${row.profile}_final${row.finalAlignMaxMoves ?? 'n/a'}_${row.code}`;
}
function summarize(rows, jumpThresholdPx) {
    const groups = {};
    for (const key of [...new Set(rows.map(groupKey))].sort()) {
        const groupRows = rows.filter((row) => groupKey(row) === key);
        groups[key] = {
            count: groupRows.length,
            preToReleasePuzzleAbs: absStat(groupRows.map((row) => row.preToReleasePuzzleDelta)),
            releaseToPostPuzzleAbs: absStat(groupRows.map((row) => row.releaseToPostPuzzleDelta)),
            exactToLatestPuzzleAbs: absStat(groupRows.map((row) => row.exactToLatestPuzzleDelta)),
            postSliderHiddenCount: groupRows.filter((row) => row.postSliderVisible === false).length,
            releaseToPostJumpCount: groupRows.filter((row) => Math.abs(row.releaseToPostPuzzleDelta || 0) > jumpThresholdPx).length,
            exactToLatestJumpCount: groupRows.filter((row) => Math.abs(row.exactToLatestPuzzleDelta || 0) > jumpThresholdPx).length,
        };
    }
    return groups;
}
function countBy(values) {
    return values.reduce((acc, value) => {
        acc[value] = (acc[value] || 0) + 1;
        return acc;
    }, {});
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
    const releaseToPostJumps = rows.filter((row) => Math.abs(row.releaseToPostPuzzleDelta || 0) > flags.jumpThresholdPx);
    const releaseToPostNonResetJumps = releaseToPostJumps.filter((row) => !row.postOutcomeReset);
    const exactToLatestJumps = rows.filter((row) => Math.abs(row.exactToLatestPuzzleDelta || 0) > flags.jumpThresholdPx);
    const preToReleaseJumps = rows.filter((row) => Math.abs(row.preToReleasePuzzleDelta || 0) > flags.jumpThresholdPx);
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        jumpThresholdPx: flags.jumpThresholdPx,
        counts: {
            rows: rows.length,
            preToReleaseJumps: preToReleaseJumps.length,
            releaseToPostJumps: releaseToPostJumps.length,
            releaseToPostNonResetJumps: releaseToPostNonResetJumps.length,
            exactToLatestJumps: exactToLatestJumps.length,
        },
        preReleaseSourceCounts: countBy(rows.map((row) => row.preReleaseSource)),
        groups: summarize(rows, flags.jumpThresholdPx),
        releaseToPostJumps,
        releaseToPostNonResetJumps,
        exactToLatestJumps,
        preToReleaseJumps,
        rows,
    };
    await mkdir(flags.outputDir, { recursive: true });
    await writeFile(path.join(flags.outputDir, 'release-drift-report.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(flags.outputDir, 'release-drift-rows.csv'), toCsv(rows));
    console.log('=== Release Drift Report ===');
    console.log(`Rows: ${rows.length}`);
    console.log(`Pre-release -> release jumps > ${flags.jumpThresholdPx}px: ${preToReleaseJumps.length}`);
    console.log(`Release -> post-wait jumps > ${flags.jumpThresholdPx}px: ${releaseToPostJumps.length}`);
    console.log(`Release -> post-wait non-reset jumps > ${flags.jumpThresholdPx}px: ${releaseToPostNonResetJumps.length}`);
    console.log(`Exact -> latest release jumps > ${flags.jumpThresholdPx}px: ${exactToLatestJumps.length}`);
    console.log('Largest pre-release -> release jumps:');
    for (const row of preToReleaseJumps
        .sort((a, b) => Math.abs(b.preToReleasePuzzleDelta || 0) - Math.abs(a.preToReleasePuzzleDelta || 0))
        .slice(0, 10)) {
        console.log(`${row.run}/${row.attempt} ${row.mode} ${row.profile} final=${row.finalAlignMaxMoves} ${row.code} target=${row.target} releaseError=${row.releaseError} preToRelease=${row.preToReleasePuzzleDelta}`);
    }
    console.log(`Saved: ${path.join(flags.outputDir, 'release-drift-report.json')}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-release-drift.js.map