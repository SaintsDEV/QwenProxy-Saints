import path from 'node:path';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TARGET_URL = '/auth?response_type=code';
const DEFAULT_RETRIES = 3;
const DEFAULT_CAPTCHA_OPEN_MODE = 'captcha_only';
function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Request body must be a JSON object');
    }
    return value;
}
function optionalString(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new Error(`${field} must be a string`);
    }
    const trimmed = value.trim();
    return trimmed || undefined;
}
function optionalPlainObject(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value;
}
function optionalBoolean(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean') {
        throw new Error(`${field} must be a boolean`);
    }
    return value;
}
function optionalNumber(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${field} must be a finite number`);
    }
    return value;
}
function optionalInteger(value, field) {
    const number = optionalNumber(value, field);
    if (number === undefined)
        return undefined;
    if (!Number.isInteger(number)) {
        throw new Error(`${field} must be an integer`);
    }
    return number;
}
function normalizePort(value, field) {
    const port = optionalInteger(value, field);
    if (port === undefined)
        return undefined;
    if (port < 1 || port > 65535) {
        throw new Error(`${field} must be between 1 and 65535`);
    }
    return port;
}
function normalizePositiveInteger(value, field) {
    const number = optionalInteger(value, field);
    if (number === undefined)
        return undefined;
    if (number < 1) {
        throw new Error(`${field} must be greater than zero`);
    }
    return number;
}
function normalizeDebugDir(value) {
    const debugDir = optionalString(value, 'debugDir');
    if (!debugDir)
        return undefined;
    if (path.isAbsolute(debugDir)) {
        throw new Error('debugDir must be a relative path');
    }
    const segments = debugDir.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
        throw new Error('debugDir must not contain . or .. path segments');
    }
    return segments.join(path.sep);
}
function normalizeGestureProfile(value) {
    const raw = optionalString(value, 'gestureProfile');
    if (!raw)
        return undefined;
    const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
    const aliases = {
        settle_back: 'settle_back',
        settle: 'settle_back',
        back: 'settle_back',
        monotonic_soft: 'monotonic_soft',
        monotonic: 'monotonic_soft',
        soft: 'monotonic_soft',
        direct_fast: 'direct_fast',
        direct: 'direct_fast',
        fast: 'direct_fast',
        human_replay: 'human_replay',
        replay: 'human_replay',
        human: 'human_replay',
    };
    const resolved = aliases[normalized];
    if (!resolved) {
        throw new Error('gestureProfile must be one of: human_replay, settle_back, monotonic_soft, direct_fast');
    }
    return resolved;
}
function normalizeCaptchaOpenMode(primaryValue, fallbackValue) {
    const raw = optionalString(primaryValue, 'captchaOpenMode') ||
        optionalString(fallbackValue, 'mode') ||
        DEFAULT_CAPTCHA_OPEN_MODE;
    const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
    const aliases = {
        captcha_only: 'captcha_only',
        captcha: 'captcha_only',
        solve_only: 'captcha_only',
        already_open: 'captcha_only',
        open_if_needed: 'open_if_needed',
        open: 'open_if_needed',
        auto: 'open_if_needed',
        legacy: 'open_if_needed',
    };
    const resolved = aliases[normalized];
    if (!resolved) {
        throw new Error('captchaOpenMode must be one of: captcha_only, open_if_needed');
    }
    return resolved;
}
function normalizeBrowser(body) {
    const browser = optionalPlainObject(body.browser, 'browser');
    const cdp = optionalPlainObject(body.cdp, 'cdp');
    const host = optionalString(browser?.host, 'browser.host') ||
        optionalString(cdp?.host, 'cdp.host') ||
        optionalString(body.host, 'host') ||
        DEFAULT_HOST;
    const port = normalizePort(browser?.port, 'browser.port') ??
        normalizePort(cdp?.port, 'cdp.port') ??
        normalizePort(body.port, 'port') ??
        normalizePort(body.cdpPort, 'cdpPort') ??
        DEFAULT_PORT;
    return { host, port };
}
export function normalizeSolveRequest(rawBody) {
    const body = asObject(rawBody);
    const browser = normalizeBrowser(body);
    const targetUrl = optionalString(body.targetUrl, 'targetUrl') || DEFAULT_TARGET_URL;
    const captchaOpenMode = normalizeCaptchaOpenMode(body.captchaOpenMode, body.mode);
    const maxRetries = normalizePositiveInteger(body.maxRetries, 'maxRetries') ??
        normalizePositiveInteger(body.retries, 'retries') ??
        DEFAULT_RETRIES;
    const waitForPuzzleTimeout = normalizePositiveInteger(body.waitForPuzzleTimeout, 'waitForPuzzleTimeout');
    const verbose = optionalBoolean(body.verbose, 'verbose') ?? true;
    const debugScreenshots = optionalBoolean(body.debugScreenshots, 'debugScreenshots');
    const debugDir = normalizeDebugDir(body.debugDir);
    const gestureProfile = normalizeGestureProfile(body.gestureProfile);
    const targetOffset = optionalNumber(body.targetOffset, 'targetOffset');
    const targetBias = optionalNumber(body.targetBias, 'targetBias');
    const reuseOpenCaptcha = optionalBoolean(body.reuseOpenCaptcha, 'reuseOpenCaptcha');
    const lightDragTrace = optionalBoolean(body.lightDragTrace, 'lightDragTrace');
    const captureFullDragTrace = optionalBoolean(body.captureFullDragTrace, 'captureFullDragTrace') ??
        (lightDragTrace === undefined ? undefined : !lightDragTrace);
    return {
        browser,
        browserKey: `${browser.host}:${browser.port}`,
        targetUrl,
        captchaOpenMode,
        maxRetries,
        waitForPuzzleTimeout,
        verbose,
        debugScreenshots,
        debugDir,
        gestureProfile,
        targetOffset,
        targetBias,
        reuseOpenCaptcha,
        captureFullDragTrace,
    };
}
//# sourceMappingURL=request.js.map