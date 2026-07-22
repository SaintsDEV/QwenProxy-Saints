#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || 'manual-handoffs')),
        output: flags.output ? path.resolve(process.cwd(), String(flags.output)) : path.resolve(process.cwd(), path.join('manual-handoffs', 'manual-audit.json')),
        limitRuns: Number(flags['limit-runs'] || 0) || null,
    };
}
async function exists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function readJson(filePath) {
    try {
        const text = await readFile(filePath, 'utf8');
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
async function listManualRunDirs(rootDir) {
    const dirents = await readdir(rootDir, { withFileTypes: true });
    const runs = [];
    for (const dirent of dirents) {
        if (!dirent.isDirectory())
            continue;
        const directDir = path.join(rootDir, dirent.name);
        const directSummary = await readJson(path.join(directDir, 'summary.json'));
        if (directSummary) {
            runs.push({ runName: dirent.name, runDir: directDir });
            continue;
        }
        const nestedDirents = await readdir(directDir, { withFileTypes: true }).catch(() => []);
        for (const nested of nestedDirents) {
            if (!nested.isDirectory())
                continue;
            const nestedDir = path.join(directDir, nested.name);
            const nestedSummary = await readJson(path.join(nestedDir, 'summary.json'));
            if (!nestedSummary)
                continue;
            runs.push({ runName: `${dirent.name}/${nested.name}`, runDir: nestedDir });
        }
    }
    return runs.sort((a, b) => b.runName.localeCompare(a.runName));
}
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function inferObservedReleaseCount(summary, releaseTimeline) {
    const summaryCount = toNumber(summary?.observedReleaseCount);
    if (summaryCount != null)
        return summaryCount;
    const triggerCount = toNumber(releaseTimeline?.trigger?.observedReleaseCount);
    if (triggerCount != null)
        return triggerCount;
    const timelineLength = Array.isArray(releaseTimeline?.timeline) ? releaseTimeline.timeline.length : 0;
    return timelineLength > 0 ? timelineLength : null;
}
function classifyManualHandoff(entry) {
    const hasComparableBase = entry.hasAnalysis &&
        entry.hasBackground &&
        entry.hasPiece &&
        entry.hasReleaseState &&
        entry.hasReleaseTimeline &&
        entry.hasPostWaitState;
    if (hasComparableBase && entry.releaseObserved && (entry.success || entry.verifyCode === 'T001')) {
        return 'usable_reference';
    }
    if (hasComparableBase && entry.releaseObserved) {
        return 'release_only';
    }
    if (hasComparableBase && !entry.releaseObserved && entry.outcome === 'pending') {
        return 'pending_no_release';
    }
    if (entry.hasSummary || entry.hasReleaseState || entry.hasReleaseTimeline || entry.hasPostWaitState) {
        return 'legacy_incomplete';
    }
    return 'unknown';
}
async function auditRun(runName, runDir) {
    const summaryPath = path.join(runDir, 'summary.json');
    const releaseTimelinePath = path.join(runDir, 'release-timeline.json');
    const summary = await readJson(summaryPath);
    const releaseTimeline = await readJson(releaseTimelinePath);
    const observedReleaseCount = inferObservedReleaseCount(summary, releaseTimeline);
    const base = {
        runName,
        runDir,
        hasSummary: await exists(summaryPath),
        hasAnalysis: await exists(path.join(runDir, 'analysis.json')),
        hasBackground: await exists(path.join(runDir, 'background.png')),
        hasPiece: await exists(path.join(runDir, 'piece.png')),
        hasReleaseState: await exists(path.join(runDir, 'release-state.json')),
        hasReleaseTimeline: await exists(releaseTimelinePath),
        hasPostWaitState: await exists(path.join(runDir, 'post-wait-state.json')),
        outcome: summary?.outcome ? String(summary.outcome) : null,
        success: !!summary?.success,
        verifyCode: summary?.verifyCode ? String(summary.verifyCode) : null,
        observedReleaseCount,
        releaseObserved: Number(observedReleaseCount || 0) > 0,
        gestureProfile: summary?.gestureProfile ? String(summary.gestureProfile) : null,
    };
    return {
        ...base,
        classification: classifyManualHandoff(base),
    };
}
function sortEntries(record) {
    return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
async function main() {
    const flags = parseArgs();
    let runs = await listManualRunDirs(flags.rootDir);
    if (flags.limitRuns) {
        runs = runs.slice(0, flags.limitRuns);
    }
    const audits = [];
    for (const run of runs) {
        audits.push(await auditRun(run.runName, run.runDir));
    }
    const classificationCounts = {};
    const outcomeCounts = {};
    const verifyCodeCounts = {};
    let releaseObservedCount = 0;
    for (const audit of audits) {
        classificationCounts[audit.classification] = (classificationCounts[audit.classification] || 0) + 1;
        outcomeCounts[audit.outcome || 'n/a'] = (outcomeCounts[audit.outcome || 'n/a'] || 0) + 1;
        verifyCodeCounts[audit.verifyCode || 'n/a'] = (verifyCodeCounts[audit.verifyCode || 'n/a'] || 0) + 1;
        if (audit.releaseObserved)
            releaseObservedCount++;
    }
    const report = {
        generatedAt: new Date().toISOString(),
        rootDir: flags.rootDir,
        runsScanned: audits.length,
        classificationCounts,
        outcomeCounts,
        verifyCodeCounts,
        releaseObservedCount,
        usableReferenceCount: audits.filter((entry) => entry.classification === 'usable_reference').length,
        runs: audits,
    };
    await writeFile(flags.output, JSON.stringify(report, null, 2), 'utf8');
    console.log('=== Manual Handoff Audit ===');
    console.log(`Runs scanned: ${audits.length}`);
    console.log(`Classifications: ${sortEntries(classificationCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Outcomes: ${sortEntries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Verify codes: ${sortEntries(verifyCodeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`Release observed: ${releaseObservedCount}/${audits.length}`);
    console.log(`Usable references: ${audits.filter((entry) => entry.classification === 'usable_reference').length}`);
    console.log(`Saved audit: ${flags.output}`);
}
await main();
//# sourceMappingURL=audit-manual-handoffs.js.map