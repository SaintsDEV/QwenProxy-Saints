#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
    const runsInput = String(flags.runs || flags.run || '').trim();
    if (!runsInput)
        throw new Error('Missing --runs <run-id-or-path[,run-id-or-path...]>');
    const runs = runsInput
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((run) => path.isAbsolute(run) ? run : path.resolve(process.cwd(), 'isolated-runs', run));
    return {
        runs,
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-environment-comparison')),
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
function latestDataLength(summary) {
    const timeline = summary?.captchaFlow?.timeline || [];
    for (let i = timeline.length - 1; i >= 0; i--) {
        const length = timeline[i]?.captchaVerifyParamInfo?.dataLength;
        if (typeof length === 'number' && Number.isFinite(length))
            return length;
    }
    return null;
}
function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length)
        return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3));
}
function countBy(items, pick) {
    const counts = {};
    for (const item of items) {
        const key = pick(item) || 'n/a';
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
function rectString(rect) {
    if (!rect)
        return 'n/a';
    return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
}
function viewportString(env, state) {
    const viewport = env?.page?.viewport || state?.context?.page?.viewport;
    return viewport ? `${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}` : 'n/a';
}
function browserWindowString(env) {
    const bounds = env?.browserWindow?.bounds;
    if (!bounds)
        return 'n/a';
    const left = Number(bounds.left ?? 0);
    const top = Number(bounds.top ?? 0);
    const width = Number(bounds.width ?? 0);
    const height = Number(bounds.height ?? 0);
    const state = String(bounds.windowState || '').trim();
    return `${left},${top},${width}x${height}${state ? ` ${state}` : ''}`;
}
function inferFlags(attemptDir, summary, env, state) {
    const flags = new Set([
        ...(summary?.environmentFlags || []),
        ...(env?.flags || []),
    ]);
    const viewport = env?.page?.viewport || state?.context?.page?.viewport;
    const windowRect = env?.page?.captcha?.windowRect || state?.context?.page?.elements?.window?.rect || null;
    const outcome = state?.visualOutcome || summary?.visualOutcome || null;
    if (viewport) {
        if (viewport.width >= 1500)
            flags.add('wide_viewport');
        if (viewport.height >= 900)
            flags.add('tall_viewport');
    }
    else {
        flags.add('missing_viewport');
    }
    if (windowRect && viewport) {
        const rightGap = viewport.width - (windowRect.x + windowRect.width);
        const bottomGap = viewport.height - (windowRect.y + windowRect.height);
        if (windowRect.x < 24)
            flags.add('captcha_near_left_edge');
        if (windowRect.y < 24)
            flags.add('captcha_near_top_edge');
        if (rightGap < 24)
            flags.add('captcha_near_right_edge');
        if (bottomGap < 24)
            flags.add('captcha_near_bottom_edge');
    }
    else {
        flags.add('missing_captcha_window_rect');
    }
    const bodyText = `${state?.context?.page?.bodyText || ''} ${outcome?.text || ''}`.toLowerCase();
    if (/google translate|traduzir|ingl[eê]s|portugu[eê]s/.test(bodyText))
        flags.add('translate_text_in_page_dom');
    if (outcome?.kind && outcome.bannerVisible === false)
        flags.add('outcome_banner_not_visible_at_capture');
    if (outcome?.kind && !existsSync(path.join(attemptDir, 'outcome-captcha.png')))
        flags.add('missing_outcome_fullpage_png');
    if (outcome?.kind && !existsSync(path.join(attemptDir, 'outcome-captcha.window.png')))
        flags.add('missing_outcome_window_png');
    return [...flags].sort();
}
async function readRunRows(runDir) {
    const entries = await readdir(runDir, { withFileTypes: true });
    const attempts = entries
        .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    const run = path.basename(runDir);
    const rows = [];
    for (const attempt of attempts) {
        const attemptDir = path.join(runDir, attempt);
        const summary = await readJson(path.join(attemptDir, 'summary.json'));
        const env = await readJson(path.join(attemptDir, 'environment-state.json'));
        const outcomeState = await readJson(path.join(attemptDir, 'outcome-captcha.json'));
        const postWaitState = await readJson(path.join(attemptDir, 'post-wait-state.json'));
        const state = outcomeState || postWaitState;
        const outcome = state?.visualOutcome || summary?.visualOutcome || null;
        const captchaWindow = env?.page?.captcha?.windowRect || state?.context?.page?.elements?.window?.rect || null;
        rows.push({
            run,
            attempt,
            success: !!summary?.success,
            verifyCode: summary?.verifyCode || 'n/a',
            visualOutcome: outcome?.kind || 'n/a',
            viewport: viewportString(env, state),
            browserWindow: browserWindowString(env),
            captchaWindow: rectString(captchaWindow),
            releaseErrorPx: typeof summary?.releasePositionErrorPx === 'number' ? summary.releasePositionErrorPx : null,
            lastMoveToReleaseMs: typeof summary?.dragResult?.lastMoveToReleaseMs === 'number' ? summary.dragResult.lastMoveToReleaseMs : null,
            dataLength: latestDataLength(summary),
            flags: inferFlags(attemptDir, summary, env, state),
        });
    }
    return rows;
}
function summarizeRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = `${row.run}::${row.verifyCode}`;
        const existing = groups.get(key) || [];
        existing.push(row);
        groups.set(key, existing);
    }
    return [...groups.entries()].map(([key, groupRows]) => {
        const [run, verifyCode] = key.split('::');
        return {
            run,
            verifyCode,
            attempts: groupRows.length,
            success: groupRows.filter((row) => row.success).length,
            visualOutcomeCounts: countBy(groupRows, (row) => row.visualOutcome),
            viewportCounts: countBy(groupRows, (row) => row.viewport),
            browserWindowCounts: countBy(groupRows, (row) => row.browserWindow),
            captchaWindowCounts: countBy(groupRows, (row) => row.captchaWindow),
            flagCounts: countBy(groupRows.flatMap((row) => row.flags), (flag) => flag),
            releaseErrorMedian: median(groupRows.flatMap((row) => row.releaseErrorPx == null ? [] : [row.releaseErrorPx])),
            lastMoveToReleaseMedian: median(groupRows.flatMap((row) => row.lastMoveToReleaseMs == null ? [] : [row.lastMoveToReleaseMs])),
            dataLengthMedian: median(groupRows.flatMap((row) => row.dataLength == null ? [] : [row.dataLength])),
        };
    });
}
function csvEscape(value) {
    const text = Array.isArray(value) ? value.join('|') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function countsText(counts) {
    const entries = Object.entries(counts);
    if (!entries.length)
        return 'none';
    return entries.map(([key, count]) => `${key}=${count}`).join('; ');
}
async function main() {
    const flags = parseArgs();
    await mkdir(flags.outputDir, { recursive: true });
    const rows = (await Promise.all(flags.runs.map((run) => readRunRows(run)))).flat();
    if (!rows.length)
        throw new Error('No attempt rows found');
    const summary = summarizeRows(rows);
    const outputBase = path.join(flags.outputDir, 'environment-comparison');
    await writeFile(`${outputBase}.json`, JSON.stringify({ runs: flags.runs, rows, summary }, null, 2), 'utf8');
    await writeFile(`${outputBase}.csv`, [
        ['run', 'attempt', 'success', 'verifyCode', 'visualOutcome', 'viewport', 'browserWindow', 'captchaWindow', 'releaseErrorPx', 'lastMoveToReleaseMs', 'dataLength', 'flags'].join(','),
        ...rows.map((row) => [
            row.run,
            row.attempt,
            row.success,
            row.verifyCode,
            row.visualOutcome,
            row.viewport,
            row.browserWindow,
            row.captchaWindow,
            row.releaseErrorPx ?? '',
            row.lastMoveToReleaseMs ?? '',
            row.dataLength ?? '',
            row.flags.join('|'),
        ].map(csvEscape).join(',')),
    ].join('\n'), 'utf8');
    await writeFile(`${outputBase}.md`, [
        '# Environment Comparison',
        '',
        '| run | code | attempts | success | releaseErrMed | releaseGapMed | dataLenMed | viewports | captchaWindows | flags |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
        ...summary.map((row) => `| ${row.run} | ${row.verifyCode} | ${row.attempts} | ${row.success} | ${row.releaseErrorMedian ?? 'n/a'} | ${row.lastMoveToReleaseMedian ?? 'n/a'} | ${row.dataLengthMedian ?? 'n/a'} | ${countsText(row.viewportCounts)} | ${countsText(row.captchaWindowCounts)} | ${countsText(row.flagCounts)} |`),
        '',
        'Notes:',
        '- Environment flags are diagnostics, not proof of rejection.',
        '- Runs without `environment-state.json` use older post-wait/outcome context as fallback and cannot report browser window bounds.',
        '- Browser UI such as Chrome Translate popups usually is not visible to page DOM.',
    ].join('\n'), 'utf8');
    console.log(`Saved: ${outputBase}.json`);
    console.log(`Saved: ${outputBase}.csv`);
    console.log(`Saved: ${outputBase}.md`);
    console.log(`Rows: ${rows.length}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-environment-comparison.js.map