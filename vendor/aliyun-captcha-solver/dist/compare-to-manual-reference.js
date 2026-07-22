#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const FEATURE_KEYS = [
    'confidence',
    'targetX',
    'targetDisplayX',
    'releasePositionErrorPx',
    'releaseSettledPositionErrorPx',
    'edgeX',
    'contourX',
    'gapX',
    'nccX',
    'captchaRequestCount',
    'captchaResponseCount',
];
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
        manualDataset: path.resolve(process.cwd(), String(flags['manual-dataset'] || path.join('manual-handoffs', 'manual-dataset.json'))),
        isolatedDataset: path.resolve(process.cwd(), String(flags['isolated-dataset'] || path.join('isolated-runs', 'comparable-dataset-settle-back.json'))),
        output: path.resolve(process.cwd(), String(flags.output || path.join('isolated-runs', 'manual-reference-compare.json'))),
        gestureProfile: flags.profile ? String(flags.profile) : null,
        manualVerifyCode: flags['manual-verify-code'] ? String(flags['manual-verify-code']) : null,
        requireManualSuccess: !flags['allow-manual-non-success'],
        top: Number(flags.top || 15) || 15,
    };
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
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function pickFeatureVector(row) {
    return {
        confidence: toNumber(row.confidence),
        targetX: toNumber(row.targetX),
        targetDisplayX: toNumber(row.targetDisplayX),
        releasePositionErrorPx: toNumber(row.releasePositionErrorPx),
        releaseSettledPositionErrorPx: toNumber(row.releaseSettledPositionErrorPx),
        edgeX: toNumber(row.edgeX),
        contourX: toNumber(row.contourX),
        gapX: toNumber(row.gapX),
        nccX: toNumber(row.nccX),
        captchaRequestCount: toNumber(row.captchaRequestCount),
        captchaResponseCount: toNumber(row.captchaResponseCount),
    };
}
function actionSignature(actions) {
    return actions.join('>');
}
function buildReference(rows) {
    const reference = {};
    for (const key of FEATURE_KEYS) {
        const values = rows.map((row) => pickFeatureVector(row)[key]).filter((value) => value != null);
        reference[key] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }
    return reference;
}
function buildScales(rows) {
    const scales = {};
    for (const key of FEATURE_KEYS) {
        const values = rows
            .map((row) => pickFeatureVector(row)[key])
            .filter((value) => value != null);
        if (values.length < 2) {
            scales[key] = 1;
            continue;
        }
        const min = Math.min(...values);
        const max = Math.max(...values);
        scales[key] = max > min ? max - min : 1;
    }
    return scales;
}
function compareRow(row, reference, scales) {
    const vector = pickFeatureVector(row);
    let distance = 0;
    let comparedFeatures = 0;
    const deltas = {};
    for (const key of FEATURE_KEYS) {
        const refValue = reference[key];
        const rowValue = vector[key];
        if (refValue == null || rowValue == null) {
            deltas[key] = null;
            continue;
        }
        const delta = rowValue - refValue;
        deltas[key] = Number(delta.toFixed(3));
        distance += Math.abs(delta) / scales[key];
        comparedFeatures++;
    }
    return {
        runName: row.runName,
        attemptName: row.attemptName,
        verifyCode: row.verifyCode,
        success: row.success,
        gestureProfile: row.gestureProfile,
        distance: comparedFeatures ? Number(distance.toFixed(4)) : null,
        comparedFeatures,
        requestActionSignature: actionSignature(row.captchaRequestActions || []),
        responseCodeSignature: actionSignature(row.captchaResponseCodes || []),
        features: vector,
        deltas,
    };
}
async function main() {
    const flags = parseArgs();
    const manualDataset = await readJson(flags.manualDataset);
    const isolatedDataset = await readJson(flags.isolatedDataset);
    const manualRows = Array.isArray(manualDataset?.rows) ? manualDataset.rows : [];
    const isolatedRows = Array.isArray(isolatedDataset?.rows) ? isolatedDataset.rows : [];
    const eligibleManualRows = manualRows.filter((row) => {
        if (!row.releaseObserved)
            return false;
        if (flags.requireManualSuccess && !row.success)
            return false;
        if (flags.manualVerifyCode && row.verifyCode !== flags.manualVerifyCode)
            return false;
        return true;
    });
    const eligibleIsolatedRows = isolatedRows.filter((row) => {
        if (flags.gestureProfile && row.gestureProfile !== flags.gestureProfile)
            return false;
        return true;
    });
    if (eligibleManualRows.length === 0) {
        const emptyReport = {
            generatedAt: new Date().toISOString(),
            manualDataset: flags.manualDataset,
            isolatedDataset: flags.isolatedDataset,
            filters: {
                gestureProfile: flags.gestureProfile,
                manualVerifyCode: flags.manualVerifyCode,
                requireManualSuccess: flags.requireManualSuccess,
            },
            status: 'no_manual_reference',
            message: 'No manual rows with observed release matched the requested filters.',
            eligibleManualRows: 0,
            eligibleIsolatedRows: eligibleIsolatedRows.length,
            topMatches: [],
        };
        await writeFile(flags.output, JSON.stringify(emptyReport, null, 2), 'utf8');
        console.log('=== Manual Reference Compare ===');
        console.log('No eligible manual references with observed release.');
        console.log(`Saved report: ${flags.output}`);
        return;
    }
    const reference = buildReference(eligibleManualRows);
    const scales = buildScales([...eligibleManualRows, ...eligibleIsolatedRows]);
    const topMatches = eligibleIsolatedRows
        .map((row) => compareRow(row, reference, scales))
        .filter((row) => row.distance != null)
        .sort((a, b) => (a.distance - b.distance) || a.runName.localeCompare(b.runName) || a.attemptName.localeCompare(b.attemptName))
        .slice(0, flags.top);
    const report = {
        generatedAt: new Date().toISOString(),
        manualDataset: flags.manualDataset,
        isolatedDataset: flags.isolatedDataset,
        filters: {
            gestureProfile: flags.gestureProfile,
            manualVerifyCode: flags.manualVerifyCode,
            requireManualSuccess: flags.requireManualSuccess,
        },
        status: 'ok',
        eligibleManualRows: eligibleManualRows.length,
        eligibleIsolatedRows: eligibleIsolatedRows.length,
        manualReferences: eligibleManualRows.map((row) => ({
            runName: row.runName,
            verifyCode: row.verifyCode,
            success: row.success,
            releaseObserved: row.releaseObserved,
            requestActionSignature: actionSignature(row.captchaRequestActions || []),
            responseCodeSignature: actionSignature(row.captchaResponseCodes || []),
            features: pickFeatureVector(row),
        })),
        reference,
        topMatches,
    };
    await writeFile(flags.output, JSON.stringify(report, null, 2), 'utf8');
    console.log('=== Manual Reference Compare ===');
    console.log(`Manual references: ${eligibleManualRows.length}`);
    console.log(`Candidate isolated rows: ${eligibleIsolatedRows.length}`);
    console.log(`Top matches exported: ${topMatches.length}`);
    console.log(`Saved report: ${flags.output}`);
}
await main();
//# sourceMappingURL=compare-to-manual-reference.js.map