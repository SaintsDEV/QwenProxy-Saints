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
    const run = String(flags.run || '');
    if (!run)
        throw new Error('Missing --run <run-id-or-path>');
    return {
        runDir: path.isAbsolute(run) ? run : path.resolve(process.cwd(), 'isolated-runs', run),
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-layout-run')),
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
function rectString(rect) {
    if (!rect)
        return 'n/a';
    return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
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
function csvEscape(value) {
    const text = Array.isArray(value) ? value.join('|') : String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function browserWindowString(envState) {
    const bounds = envState?.browserWindow?.bounds;
    if (!bounds)
        return 'n/a';
    const left = Number(bounds.left ?? 0);
    const top = Number(bounds.top ?? 0);
    const width = Number(bounds.width ?? 0);
    const height = Number(bounds.height ?? 0);
    const state = String(bounds.windowState || '').trim();
    return `${left},${top},${width}x${height}${state ? ` ${state}` : ''}`;
}
function makeLayoutRow(attempt, attemptDir, summary, state, envState) {
    const page = state?.context?.page;
    const viewport = envState?.page?.viewport || page?.viewport;
    const windowRect = envState?.page?.captcha?.windowRect || page?.elements?.window?.rect || null;
    const imageBoxRect = envState?.page?.captcha?.imageBoxRect || page?.elements?.imageBox?.rect || null;
    const outcome = state?.visualOutcome || summary?.visualOutcome || null;
    const flags = new Set([
        ...(summary?.environmentFlags || []),
        ...(envState?.flags || []),
    ]);
    if (!viewport) {
        flags.add('missing_viewport');
    }
    else {
        if (viewport.width >= 1500)
            flags.add('wide_viewport');
        if (viewport.height >= 900)
            flags.add('tall_viewport');
    }
    if (!windowRect) {
        flags.add('missing_captcha_window_rect');
    }
    else if (viewport) {
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
    const bodyText = `${page?.bodyText || ''} ${outcome?.text || ''}`.toLowerCase();
    if (/google translate|traduzir|ingl[eê]s|portugu[eê]s/.test(bodyText))
        flags.add('translate_text_in_page_dom');
    if (outcome?.kind && outcome.bannerVisible === false)
        flags.add('outcome_banner_not_visible_at_capture');
    if (outcome?.kind && !existsSync(path.join(attemptDir, 'outcome-captcha.png')))
        flags.add('missing_outcome_fullpage_png');
    if (outcome?.kind && !existsSync(path.join(attemptDir, 'outcome-captcha.window.png')))
        flags.add('missing_outcome_window_png');
    const viewportText = viewport ? `${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}` : 'n/a';
    return {
        attempt,
        success: !!summary?.success,
        verifyCode: summary?.verifyCode || 'n/a',
        visualOutcome: outcome?.kind || 'n/a',
        viewport: viewportText,
        browserWindow: browserWindowString(envState),
        windowRect: rectString(windowRect),
        imageBoxRect: rectString(imageBoxRect),
        releaseErrorPx: typeof summary?.releasePositionErrorPx === 'number' ? summary.releasePositionErrorPx : null,
        lastMoveToReleaseMs: typeof summary?.dragResult?.lastMoveToReleaseMs === 'number' ? summary.dragResult.lastMoveToReleaseMs : null,
        dataLength: latestDataLength(summary),
        flags: [...flags],
    };
}
async function main() {
    const flags = parseArgs();
    const entries = await readdir(flags.runDir, { withFileTypes: true });
    const attempts = entries
        .filter((entry) => entry.isDirectory() && /^attempt-\d+/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    if (!attempts.length)
        throw new Error(`No attempt directories found in ${flags.runDir}`);
    await mkdir(flags.outputDir, { recursive: true });
    const rows = [];
    for (const attempt of attempts) {
        const attemptDir = path.join(flags.runDir, attempt);
        const summary = await readJson(path.join(attemptDir, 'summary.json'));
        const outcomeState = await readJson(path.join(attemptDir, 'outcome-captcha.json'));
        const postWaitState = await readJson(path.join(attemptDir, 'post-wait-state.json'));
        const envState = await readJson(path.join(attemptDir, 'environment-state.json'));
        rows.push(makeLayoutRow(attempt, attemptDir, summary, outcomeState || postWaitState, envState));
    }
    const runName = path.basename(flags.runDir);
    const jsonPath = path.join(flags.outputDir, `${runName}-layout-summary.json`);
    const csvPath = path.join(flags.outputDir, `${runName}-layout-summary.csv`);
    const mdPath = path.join(flags.outputDir, `${runName}-layout-summary.md`);
    await writeFile(jsonPath, JSON.stringify({ runDir: flags.runDir, rows }, null, 2), 'utf8');
    await writeFile(csvPath, [
        ['attempt', 'success', 'verifyCode', 'visualOutcome', 'viewport', 'browserWindow', 'windowRect', 'imageBoxRect', 'releaseErrorPx', 'lastMoveToReleaseMs', 'dataLength', 'flags'].join(','),
        ...rows.map((row) => [
            row.attempt,
            row.success,
            row.verifyCode,
            row.visualOutcome,
            row.viewport,
            row.browserWindow,
            row.windowRect,
            row.imageBoxRect,
            row.releaseErrorPx ?? '',
            row.lastMoveToReleaseMs ?? '',
            row.dataLength ?? '',
            row.flags.join('|'),
        ].map(csvEscape).join(',')),
    ].join('\n'), 'utf8');
    await writeFile(mdPath, [
        `# Layout Summary: ${runName}`,
        '',
        '| attempt | result | visual | viewport | browser | captcha | err | releaseGap | dataLen | flags |',
        '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |',
        ...rows.map((row) => `| ${row.attempt} | ${row.success ? 'success' : 'failed'} ${row.verifyCode} | ${row.visualOutcome} | ${row.viewport} | ${row.browserWindow} | ${row.windowRect} | ${row.releaseErrorPx ?? 'n/a'} | ${row.lastMoveToReleaseMs ?? 'n/a'} | ${row.dataLength ?? 'n/a'} | ${row.flags.join(', ') || 'none'} |`),
        '',
        'Notes:',
        '- `wide_viewport` and edge flags are environment diagnostics, not proof of rejection.',
        '- Browser UI such as the Google Translate popup usually is not visible to page DOM, so absence of `translate_text_in_page_dom` does not prove it was absent on screen.',
    ].join('\n'), 'utf8');
    const flagCounts = new Map();
    for (const row of rows) {
        for (const flag of row.flags)
            flagCounts.set(flag, (flagCounts.get(flag) || 0) + 1);
    }
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${csvPath}`);
    console.log(`Saved: ${mdPath}`);
    console.log(`Rows: ${rows.length}`);
    console.log(`Flag counts: ${[...flagCounts.entries()].map(([flag, count]) => `${flag}=${count}`).join(', ') || 'none'}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-layout-run.js.map