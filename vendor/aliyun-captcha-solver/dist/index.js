#!/usr/bin/env node
import { solve } from './solver.js';
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].slice(2);
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        }
        else {
            flags[key] = true;
        }
    }
}
function flagString(name) {
    const value = flags[name];
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function flagNumber(name) {
    const value = flagString(name);
    if (!value)
        return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`--${name} must be a finite number`);
    }
    return parsed;
}
function flagInt(name) {
    const value = flagNumber(name);
    if (value === undefined)
        return undefined;
    if (!Number.isInteger(value)) {
        throw new Error(`--${name} must be an integer`);
    }
    return value;
}
function flagBool(name) {
    if (!(name in flags))
        return undefined;
    const value = flags[name];
    if (value === true)
        return true;
    const raw = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw))
        return true;
    if (['0', 'false', 'no', 'off'].includes(raw))
        return false;
    throw new Error(`--${name} must be a boolean`);
}
console.log('=== Aliyun PUZZLE Captcha Solver ===');
console.log(`CDP: ${flags.host || '127.0.0.1'}:${flags.port || 9222}`);
console.log(`Target: ${flags['target-url'] || '/auth?response_type=code'}`);
console.log(`Captcha mode: ${flags['captcha-open-mode'] || flags.mode || 'captcha_only'}`);
console.log(`Retries: ${flags.retries || 3}`);
console.log('');
const result = await solve({
    host: flagString('host') || '127.0.0.1',
    port: flagInt('port') || 9222,
    targetUrl: flagString('target-url') || '/auth?response_type=code',
    captchaOpenMode: flagString('captcha-open-mode') || flagString('mode'),
    maxRetries: flagInt('retries') || 3,
    verbose: !flags.quiet,
    waitForPuzzleTimeout: flagInt('wait-for-puzzle-timeout'),
    debugScreenshots: flagBool('debug-screenshots'),
    debugDir: flagString('debug-dir'),
    targetOffset: flagNumber('target-offset'),
    targetBias: flagNumber('target-bias'),
    gestureProfile: flagString('gesture-profile'),
    reuseOpenCaptcha: flagBool('reuse-open-captcha'),
    captureFullDragTrace: flagBool('capture-full-drag-trace'),
});
console.log('\n=== Result ===');
console.log(`Success: ${result.success}`);
console.log(`Attempts: ${result.attempts}`);
console.log(`Target X: ${result.targetX}px`);
console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
console.log(`Verify Param: ${result.captchaVerifyParam ? 'captured (' + result.captchaVerifyParam.length + ' chars)' : 'not captured'}`);
if (result.debugDir) {
    console.log(`Debug Dir: ${result.debugDir}`);
}
if (result.error) {
    console.log(`Error: ${result.error}`);
}
if (result.success && result.captchaVerifyParam) {
    console.log('\n=== Captcha Verify Param ===');
    console.log(result.captchaVerifyParam);
}
process.exit(result.success ? 0 : 1);
//# sourceMappingURL=index.js.map