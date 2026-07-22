#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
        environmentCheckPath: path.resolve(process.cwd(), String(flags['environment-check'] || 'analysis-browser-environment-current-live/browser-environment.json')),
        comparisonPath: flags.comparison
            ? path.resolve(process.cwd(), String(flags.comparison))
            : path.resolve(process.cwd(), 'analysis-environment-comparison-direct-current/environment-comparison.json'),
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-probe-readiness')),
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
function fatalFlags(flags) {
    const fatal = new Set([
        'page_hidden',
        'page_not_focused',
        'focused_but_hidden_page',
        'visual_viewport_scaled',
        'non_1x_device_pixel_ratio',
        'viewport_browser_width_mismatch',
        'viewport_browser_height_mismatch',
        'viewport_outer_width_mismatch',
        'viewport_outer_height_mismatch',
        'captcha_zoom_ratio_non_1',
        'captcha_near_left_edge',
        'captcha_near_top_edge',
        'captcha_near_right_edge',
        'captcha_near_bottom_edge',
    ]);
    return flags.filter((flag) => fatal.has(flag));
}
function viewportText(check) {
    const viewport = check?.page?.viewport;
    return viewport ? `${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}` : 'n/a';
}
function browserBoundsText(check) {
    const bounds = check?.browserWindow?.bounds;
    if (!bounds)
        return 'n/a';
    const left = Number(bounds.left ?? 0);
    const top = Number(bounds.top ?? 0);
    const width = Number(bounds.width ?? 0);
    const height = Number(bounds.height ?? 0);
    const state = String(bounds.windowState || '').trim();
    return `${left},${top},${width}x${height}${state ? ` ${state}` : ''}`;
}
function focusText(check) {
    const focus = check?.page?.focus;
    if (!focus)
        return 'n/a';
    return `hasFocus=${!!focus.hasFocus} hidden=${!!focus.hidden} visibility=${focus.visibilityState || 'n/a'}`;
}
function comparisonInsights(comparison) {
    const rows = comparison?.summary || [];
    const insights = [];
    const hasT001Wide = rows.some((row) => row.verifyCode === 'T001' && Object.keys(row.viewportCounts || {}).some((value) => value.startsWith('1680x915')));
    const hasF001Wide = rows.some((row) => row.verifyCode === 'F001' && Object.keys(row.viewportCounts || {}).some((value) => value.startsWith('1680x915')));
    const f001Rows = rows.filter((row) => row.verifyCode === 'F001');
    const t001Rows = rows.filter((row) => row.verifyCode === 'T001');
    if (hasT001Wide && hasF001Wide) {
        insights.push('Wide viewport appears in both T001 and F001, so it is not sufficient as a single-cause explanation.');
    }
    const f001GapMedian = median(f001Rows.flatMap((row) => row.lastMoveToReleaseMedian == null ? [] : [row.lastMoveToReleaseMedian]));
    const t001GapMedian = median(t001Rows.flatMap((row) => row.lastMoveToReleaseMedian == null ? [] : [row.lastMoveToReleaseMedian]));
    if (f001GapMedian != null && t001GapMedian != null) {
        insights.push(`Recent F001 release-gap median is ${f001GapMedian}ms vs T001 median ${t001GapMedian}ms.`);
    }
    const f001DataMedian = median(f001Rows.flatMap((row) => row.dataLengthMedian == null ? [] : [row.dataLengthMedian]));
    const t001DataMedian = median(t001Rows.flatMap((row) => row.dataLengthMedian == null ? [] : [row.dataLengthMedian]));
    if (f001DataMedian != null && t001DataMedian != null) {
        insights.push(`Recent F001 dataLength median is ${f001DataMedian} vs T001 median ${t001DataMedian}.`);
    }
    if (!insights.length) {
        insights.push('No comparison insights available yet.');
    }
    return insights;
}
function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length)
        return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3));
}
function makeReport(environmentCheckPath, comparisonPath, check, comparison) {
    const flags = check?.flags || [];
    const blockers = check ? fatalFlags(flags) : ['missing_environment_check'];
    const warnings = [];
    if (flags.includes('wide_viewport'))
        warnings.push('Current viewport is wide; compare separately if results differ.');
    if (flags.includes('wide_browser_window'))
        warnings.push('Current browser window is wide; compare separately if results differ.');
    if (check?.page?.captcha?.windowVisible)
        warnings.push('Captcha is already open; reload before collecting a clean attempt.');
    const ready = blockers.length === 0;
    const decision = !check
        ? 'not_ready_missing_environment'
        : ready
            ? 'ready_for_small_probe'
            : 'not_ready_dirty_environment';
    return {
        generatedAt: new Date().toISOString(),
        environmentCheckPath,
        comparisonPath,
        ready,
        decision,
        blockers,
        warnings,
        environment: {
            url: check?.page?.url || 'n/a',
            viewport: viewportText(check),
            browserBounds: browserBoundsText(check),
            focus: focusText(check),
            flags,
        },
        comparisonInsights: comparisonInsights(comparison),
        recommendedCommand: 'npm run batch:isolated -- --mode bot --target-url "/auth?response_type=code" --attempts 3 --post-wait-ms 11000 --pre-release-capture none --gesture-profile direct_fast --abort-on-dirty-environment',
    };
}
function renderMarkdown(report) {
    return [
        '# Probe Readiness',
        '',
        `- Decision: ${report.decision}`,
        `- Ready: ${report.ready}`,
        `- Environment check: ${report.environmentCheckPath}`,
        `- Comparison: ${report.comparisonPath || 'n/a'}`,
        '',
        '## Current Environment',
        '',
        `- URL: ${report.environment.url}`,
        `- Viewport: ${report.environment.viewport}`,
        `- Browser bounds: ${report.environment.browserBounds}`,
        `- Focus: ${report.environment.focus}`,
        `- Flags: ${report.environment.flags.join(', ') || 'none'}`,
        `- Blockers: ${report.blockers.join(', ') || 'none'}`,
        `- Warnings: ${report.warnings.join(', ') || 'none'}`,
        '',
        '## Comparison Insights',
        '',
        ...report.comparisonInsights.map((item) => `- ${item}`),
        '',
        '## Recommended Small Probe',
        '',
        '```powershell',
        report.recommendedCommand,
        '```',
        '',
        'Notes:',
        '- This report does not interact with the captcha.',
        '- Use the recommended command only for a small diagnostic probe after the environment is ready.',
    ].join('\n');
}
async function main() {
    const flags = parseArgs();
    const check = await readJson(flags.environmentCheckPath);
    const comparison = await readJson(flags.comparisonPath);
    const report = makeReport(flags.environmentCheckPath, flags.comparisonPath, check, comparison);
    await mkdir(flags.outputDir, { recursive: true });
    const jsonPath = path.join(flags.outputDir, 'probe-readiness.json');
    const mdPath = path.join(flags.outputDir, 'probe-readiness.md');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(mdPath, renderMarkdown(report), 'utf8');
    console.log(`Saved: ${jsonPath}`);
    console.log(`Saved: ${mdPath}`);
    console.log(`Decision: ${report.decision}`);
    console.log(`Blockers: ${report.blockers.join(', ') || 'none'}`);
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=report-probe-readiness.js.map