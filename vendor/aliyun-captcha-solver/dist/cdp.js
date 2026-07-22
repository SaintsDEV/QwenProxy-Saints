import CDP from 'chrome-remote-interface';
import { filterMatchingPageTargets } from './cdp-targeting.js';
import { parseBooleanEnvFlag, readViewportMutationPolicy } from './cdp-viewport-policy.js';
const RECOVERY_WINDOW_BOUNDS = {
    left: 120,
    top: 90,
    width: 1200,
    height: 850,
};
const MIN_HEALTHY_VIEWPORT_WIDTH = 480;
const MIN_HEALTHY_VIEWPORT_HEIGHT = 400;
const MIN_HEALTHY_VIEWPORT_RATIO = 0.5;
const DEFAULT_MAX_AUTO_RECOVERY_WINDOWS = 0;
const recoveryWindowCounts = new Map();
function getMaxAutoRecoveryWindows() {
    const rawValue = process.env.SOLVER_MAX_AUTO_RECOVERY_WINDOWS;
    if (!rawValue || !rawValue.trim()) {
        return DEFAULT_MAX_AUTO_RECOVERY_WINDOWS;
    }
    const raw = Number(rawValue);
    if (Number.isFinite(raw) && raw >= 0) {
        return Math.floor(raw);
    }
    return DEFAULT_MAX_AUTO_RECOVERY_WINDOWS;
}
function getRecoveryWindowKey(host, port, targetUrl, recoveryUrl) {
    return `${host}:${port}:${targetUrl || recoveryUrl || '*'}`;
}
function trimText(value, maxLen) {
    const text = typeof value === 'string'
        ? value
        : value == null
            ? ''
            : JSON.stringify(value);
    return text.slice(0, maxLen);
}
function pushLimited(list, value, maxSize) {
    list.push(value);
    if (list.length > maxSize) {
        list.splice(0, list.length - maxSize);
    }
}
function cssPx(value) {
    return Math.round(value);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function randomBetween(range) {
    const [min, max] = range;
    if (max <= min)
        return min;
    return min + Math.random() * (max - min);
}
function isCaptchaTraffic(url, postData = '') {
    const haystack = `${url}\n${postData}`.toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(url)) {
        return false;
    }
    return (haystack.includes('captcha-open') ||
        haystack.includes('upload.captcha') ||
        haystack.includes('cloudauth-device') ||
        haystack.includes('certifyid') ||
        haystack.includes('captchaverifyparam') ||
        haystack.includes('verifycode') ||
        haystack.includes('verifycaptchav3') ||
        haystack.includes('initcaptchav3') ||
        haystack.includes('action=log1') ||
        haystack.includes('action=log2') ||
        haystack.includes('action=log3') ||
        haystack.includes('action=uploadlog'));
}
function ensureCaptchaNetworkTrace(client) {
    const traced = client;
    if (traced.__captchaNetworkTrace)
        return;
    const state = {
        requests: [],
        responses: [],
        trackedRequestIds: new Set(),
        responseMeta: new Map(),
        requestGeneration: new Map(),
        generation: 0,
        unsubscribers: [],
    };
    traced.__captchaNetworkTrace = state;
    state.unsubscribers.push(client.Network.requestWillBeSent((params) => {
        try {
            const url = String(params?.request?.url || '');
            const postData = trimText(params?.request?.postData, 20000);
            if (!isCaptchaTraffic(url, postData))
                return;
            const requestId = String(params.requestId);
            state.trackedRequestIds.add(requestId);
            state.requestGeneration.set(requestId, state.generation);
            pushLimited(state.requests, {
                ts: Date.now(),
                requestId,
                url,
                method: String(params?.request?.method || ''),
                postData,
            }, 60);
        }
        catch { }
    }));
    state.unsubscribers.push(client.Network.responseReceived((params) => {
        try {
            const requestId = String(params?.requestId || '');
            const url = String(params?.response?.url || '');
            if (!state.trackedRequestIds.has(requestId))
                return;
            state.responseMeta.set(requestId, {
                url,
                status: Number(params?.response?.status || 0),
                mimeType: String(params?.response?.mimeType || ''),
            });
        }
        catch { }
    }));
    state.unsubscribers.push(client.Network.loadingFinished(async (params) => {
        try {
            const requestId = String(params?.requestId || '');
            if (!state.trackedRequestIds.has(requestId))
                return;
            const generation = state.requestGeneration.get(requestId);
            if (generation !== state.generation)
                return;
            const meta = state.responseMeta.get(requestId) || { url: '', status: 0, mimeType: '' };
            const bodyResult = await client.Network.getResponseBody({ requestId });
            if (generation !== state.generation)
                return;
            pushLimited(state.responses, {
                ts: Date.now(),
                requestId,
                url: meta.url,
                status: meta.status,
                mimeType: meta.mimeType,
                body: trimText(bodyResult?.body, 4000),
                base64Encoded: !!bodyResult?.base64Encoded,
            }, 60);
        }
        catch { }
    }));
}
async function listPageTargets(host, port, targetUrl) {
    const res = await fetch(`http://${host}:${port}/json`);
    const targets = await res.json();
    return filterMatchingPageTargets(targets, targetUrl);
}
function scoreViewportProbe(probe) {
    return Math.max(0, probe.innerWidth) * Math.max(0, probe.innerHeight);
}
function hasHealthyWindowShellProbe(probe) {
    const browserBounds = probe.browserWindowBounds;
    const browserBoundsHealthy = !!browserBounds && (browserBounds.windowState !== 'minimized' &&
        Number(browserBounds.width || 0) >= MIN_HEALTHY_VIEWPORT_WIDTH &&
        Number(browserBounds.height || 0) >= MIN_HEALTHY_VIEWPORT_HEIGHT);
    return (browserBoundsHealthy &&
        probe.outerWidth >= MIN_HEALTHY_VIEWPORT_WIDTH &&
        probe.outerHeight >= MIN_HEALTHY_VIEWPORT_HEIGHT);
}
function isHealthyViewportProbe(probe) {
    if (probe.outerWidth <= 0 || probe.outerHeight <= 0) {
        return false;
    }
    const widthRatio = probe.innerWidth / probe.outerWidth;
    const heightRatio = probe.innerHeight / probe.outerHeight;
    const browserBounds = probe.browserWindowBounds;
    const browserBoundsHealthy = !browserBounds || (browserBounds.windowState !== 'minimized' &&
        Number(browserBounds.width || 0) >= MIN_HEALTHY_VIEWPORT_WIDTH &&
        Number(browserBounds.height || 0) >= MIN_HEALTHY_VIEWPORT_HEIGHT);
    return (probe.innerWidth >= MIN_HEALTHY_VIEWPORT_WIDTH &&
        probe.innerHeight >= MIN_HEALTHY_VIEWPORT_HEIGHT &&
        probe.visualViewportWidth >= MIN_HEALTHY_VIEWPORT_WIDTH &&
        probe.visualViewportHeight >= MIN_HEALTHY_VIEWPORT_HEIGHT &&
        widthRatio >= MIN_HEALTHY_VIEWPORT_RATIO &&
        heightRatio >= MIN_HEALTHY_VIEWPORT_RATIO &&
        browserBoundsHealthy);
}
function probeSizeText(probe) {
    if (!probe)
        return 'n/a';
    const bounds = probe.browserWindowBounds;
    const boundsText = bounds
        ? ` bounds=${bounds.width || 0}x${bounds.height || 0} ${bounds.windowState || ''}`.trim()
        : ' bounds=n/a';
    return `inner=${probe.innerWidth}x${probe.innerHeight} visual=${Math.round(probe.visualViewportWidth)}x${Math.round(probe.visualViewportHeight)} outer=${probe.outerWidth}x${probe.outerHeight} ${boundsText}`;
}
async function probeTargetViewport(host, port, target) {
    const client = await CDP({ host, port, target });
    try {
        await client.Runtime.enable();
        const result = await client.Runtime.evaluate({
            expression: `({
        href: location.href,
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        visualViewportWidth: visualViewport?.width || 0,
        visualViewportHeight: visualViewport?.height || 0,
        devicePixelRatio
      })`,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10000,
        });
        if (result.exceptionDetails || !result.result?.value)
            return null;
        const value = result.result.value;
        let browserWindowBounds = null;
        try {
            const browserWindow = await client.Browser?.getWindowForTarget?.();
            if (browserWindow?.bounds) {
                browserWindowBounds = {
                    left: Number(browserWindow.bounds.left),
                    top: Number(browserWindow.bounds.top),
                    width: Number(browserWindow.bounds.width),
                    height: Number(browserWindow.bounds.height),
                    windowState: String(browserWindow.bounds.windowState || ''),
                };
            }
        }
        catch { }
        return {
            target,
            href: String(value.href || target.url || ''),
            innerWidth: Number(value.innerWidth || 0),
            innerHeight: Number(value.innerHeight || 0),
            outerWidth: Number(value.outerWidth || 0),
            outerHeight: Number(value.outerHeight || 0),
            visualViewportWidth: Number(value.visualViewportWidth || 0),
            visualViewportHeight: Number(value.visualViewportHeight || 0),
            devicePixelRatio: Number(value.devicePixelRatio || 0),
            browserWindowBounds,
        };
    }
    catch {
        return null;
    }
    finally {
        try {
            await client.close();
        }
        catch { }
    }
}
async function waitForTargetById(host, port, targetId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const targets = await listPageTargets(host, port);
        const match = targets.find((target) => target.id === targetId);
        if (match)
            return match;
        await sleep(200);
    }
    return null;
}
async function createRecoveryTarget(host, port, url) {
    const browserClient = await CDP({ host, port, target: false });
    try {
        const created = await browserClient.Target.createTarget({
            url,
            newWindow: true,
            left: RECOVERY_WINDOW_BOUNDS.left,
            top: RECOVERY_WINDOW_BOUNDS.top,
            width: RECOVERY_WINDOW_BOUNDS.width,
            height: RECOVERY_WINDOW_BOUNDS.height,
        });
        return waitForTargetById(host, port, String(created?.targetId || ''), 10000);
    }
    catch {
        return null;
    }
    finally {
        try {
            await browserClient.close();
        }
        catch { }
    }
}
async function recoverTargetViewportInPlace(host, port, target) {
    const client = await CDP({ host, port, target });
    try {
        try {
            await client.Page.enable();
        }
        catch { }
        try {
            await client.Runtime.enable();
        }
        catch { }
        try {
            await client.Page.bringToFront();
        }
        catch { }
        try {
            await client.Emulation?.clearDeviceMetricsOverride?.();
        }
        catch { }
        try {
            if (client.Browser?.getWindowForTarget && client.Browser?.setWindowBounds) {
                const browserWindow = await client.Browser.getWindowForTarget();
                const windowId = Number(browserWindow?.windowId || 0);
                if (windowId > 0) {
                    await client.Browser.setWindowBounds({
                        windowId,
                        bounds: {
                            left: RECOVERY_WINDOW_BOUNDS.left,
                            top: RECOVERY_WINDOW_BOUNDS.top,
                            width: RECOVERY_WINDOW_BOUNDS.width,
                            height: RECOVERY_WINDOW_BOUNDS.height,
                            windowState: 'normal',
                        },
                    });
                }
            }
        }
        catch { }
        try {
            await client.Runtime.evaluate({
                expression: `(() => {
          try { window.moveTo(${RECOVERY_WINDOW_BOUNDS.left}, ${RECOVERY_WINDOW_BOUNDS.top}); } catch {}
          try { window.resizeTo(${RECOVERY_WINDOW_BOUNDS.width}, ${RECOVERY_WINDOW_BOUNDS.height}); } catch {}
          return {
            innerWidth,
            innerHeight,
            outerWidth,
            outerHeight
          };
        })()`,
                returnByValue: true,
                awaitPromise: true,
                timeout: 10000,
            });
        }
        catch { }
        await sleep(150);
    }
    finally {
        try {
            await client.close();
        }
        catch { }
    }
    return probeTargetViewport(host, port, target);
}
async function prepareCDPClient(host, port, target, options = {}) {
    const client = await CDP({ host, port, target });
    const close = client.close.bind(client);
    await client.Network.enable({
        maxTotalBufferSize: 1024 * 1024 * 8,
        maxResourceBufferSize: 1024 * 1024 * 2,
        maxPostDataSize: 1024 * 128,
    });
    await client.Page.enable();
    await client.Runtime.enable();
    ensureCaptchaNetworkTrace(client);
    try {
        await client.Page.bringToFront();
    }
    catch { }
    try {
        const trackedOverride = await client.Runtime.evaluate({
            expression: '!!window.__solverDeviceMetricsOverrideApplied',
            returnByValue: true,
            awaitPromise: true,
            timeout: 5000,
        });
        if (trackedOverride.result?.value) {
            try {
                await client.Emulation?.clearDeviceMetricsOverride?.();
            }
            catch { }
            try {
                await client.Runtime.evaluate({
                    expression: 'window.__solverDeviceMetricsOverrideApplied = false',
                    returnByValue: true,
                    awaitPromise: true,
                    timeout: 5000,
                });
            }
            catch { }
        }
    }
    catch { }
    let appliedViewportOverride = false;
    if (options.normalizeViewport) {
        try {
            await client.Emulation?.setDeviceMetricsOverride?.({
                width: RECOVERY_WINDOW_BOUNDS.width,
                height: RECOVERY_WINDOW_BOUNDS.height,
                deviceScaleFactor: 1,
                mobile: false,
                screenWidth: RECOVERY_WINDOW_BOUNDS.width,
                screenHeight: RECOVERY_WINDOW_BOUNDS.height,
                positionX: 0,
                positionY: 0,
                dontSetVisibleSize: false,
                scale: 1,
            });
            try {
                await client.Runtime.evaluate({
                    expression: 'window.__solverDeviceMetricsOverrideApplied = true',
                    returnByValue: true,
                    awaitPromise: true,
                    timeout: 5000,
                });
            }
            catch { }
            appliedViewportOverride = true;
        }
        catch { }
    }
    client.close = async () => {
        if (appliedViewportOverride) {
            try {
                await client.Emulation?.clearDeviceMetricsOverride?.();
            }
            catch { }
            try {
                await client.Runtime.evaluate({
                    expression: 'window.__solverDeviceMetricsOverrideApplied = false',
                    returnByValue: true,
                    awaitPromise: true,
                    timeout: 5000,
                });
            }
            catch { }
        }
        await close();
    };
    return client;
}
export async function connectCDP(host = '127.0.0.1', port = 9222, targetUrl) {
    let target = undefined;
    let normalizeViewport = false;
    const viewportPolicy = readViewportMutationPolicy();
    if (targetUrl) {
        const targets = await listPageTargets(host, port, targetUrl);
        if (!targets.length) {
            const pages = (await listPageTargets(host, port)).map((t) => t.url);
            throw new Error(`No CDP target matching "${targetUrl}". Available pages: ${pages.join(', ')}`);
        }
        const probes = (await Promise.all(targets.map((candidate) => probeTargetViewport(host, port, candidate))))
            .filter((probe) => !!probe)
            .sort((a, b) => {
            const healthyDelta = Number(isHealthyViewportProbe(b)) - Number(isHealthyViewportProbe(a));
            if (healthyDelta !== 0)
                return healthyDelta;
            const matchScoreDelta = Number(b.target.matchScore || 0) - Number(a.target.matchScore || 0);
            if (matchScoreDelta !== 0)
                return matchScoreDelta;
            return scoreViewportProbe(b) - scoreViewportProbe(a);
        });
        const preferred = probes[0];
        if (preferred && isHealthyViewportProbe(preferred)) {
            recoveryWindowCounts.delete(getRecoveryWindowKey(host, port, targetUrl, preferred.href));
            target = preferred.target;
        }
        else if (preferred && hasHealthyWindowShellProbe(preferred)) {
            recoveryWindowCounts.delete(getRecoveryWindowKey(host, port, targetUrl, preferred.href));
            target = preferred.target;
            if (viewportPolicy.allowViewportNormalization) {
                normalizeViewport = true;
            }
            else {
                console.warn(`[cdp] Matched "${targetUrl}" with a window shell that looks healthy but a viewport that does not (${probeSizeText(preferred)}). Attaching without device metrics override in conservative mode.`);
            }
        }
        else {
            const collapsedProbe = preferred || null;
            const recoveredProbe = collapsedProbe
                ? (viewportPolicy.allowInPlaceRecovery
                    ? await recoverTargetViewportInPlace(host, port, collapsedProbe.target)
                    : null)
                : null;
            if (recoveredProbe && isHealthyViewportProbe(recoveredProbe)) {
                recoveryWindowCounts.delete(getRecoveryWindowKey(host, port, targetUrl, recoveredProbe.href));
                target = recoveredProbe.target;
            }
            else if (recoveredProbe && hasHealthyWindowShellProbe(recoveredProbe)) {
                recoveryWindowCounts.delete(getRecoveryWindowKey(host, port, targetUrl, recoveredProbe.href));
                target = recoveredProbe.target;
                if (viewportPolicy.allowViewportNormalization) {
                    normalizeViewport = true;
                }
                else {
                    console.warn(`[cdp] Recovered "${targetUrl}" to a healthy shell without a healthy viewport (${probeSizeText(recoveredProbe)}). Attaching without device metrics override in conservative mode.`);
                }
            }
            const recoveryUrl = preferred?.href || String(targets[0].url || '');
            if (recoveryUrl) {
                if (target) {
                    return prepareCDPClient(host, port, target, { normalizeViewport });
                }
                if (collapsedProbe && !viewportPolicy.allowInPlaceRecovery) {
                    throw new Error(`Collapsed CDP target matched "${targetUrl}" (${collapsedProbe.innerWidth}x${collapsedProbe.innerHeight}; ${probeSizeText(collapsedProbe)}). Conservative mode skipped automatic viewport recovery. Reopen or resize a healthy target manually, or enable SOLVER_ALLOW_INPLACE_VIEWPORT_RECOVERY=1 before retrying.`);
                }
                const recoveryKey = getRecoveryWindowKey(host, port, targetUrl, recoveryUrl);
                const maxAutoRecoveryWindows = getMaxAutoRecoveryWindows();
                const recoveryCount = recoveryWindowCounts.get(recoveryKey) || 0;
                const collapsedWidth = preferred?.innerWidth ?? 0;
                const collapsedHeight = preferred?.innerHeight ?? 0;
                if (recoveryCount >= maxAutoRecoveryWindows) {
                    throw new Error(`Collapsed CDP target matched "${targetUrl}" (${collapsedWidth}x${collapsedHeight}; ${probeSizeText(preferred)}) and auto-recovery limit (${maxAutoRecoveryWindows}) was reached. Reopen or resize a healthy target manually before retrying.`);
                }
                console.warn(`[cdp] Collapsed target matched "${targetUrl}" (${collapsedWidth}x${collapsedHeight}; ${probeSizeText(preferred)}). Opening recovery window ${recoveryCount + 1}/${maxAutoRecoveryWindows} for ${recoveryUrl}.`);
                target = await createRecoveryTarget(host, port, recoveryUrl);
                if (target) {
                    recoveryWindowCounts.set(recoveryKey, recoveryCount + 1);
                }
            }
            if (!target) {
                const fallbackWidth = preferred?.innerWidth ?? 0;
                const fallbackHeight = preferred?.innerHeight ?? 0;
                throw new Error(`Collapsed CDP target matched "${targetUrl}" (${fallbackWidth}x${fallbackHeight}; ${probeSizeText(preferred)}) and recovery window creation failed.`);
            }
        }
    }
    return prepareCDPClient(host, port, target, { normalizeViewport });
}
export async function evaluate(client, expression) {
    const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 30000,
    });
    if (result.exceptionDetails) {
        throw new Error(`JS Error: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
}
export async function evaluateWithTimeout(client, expression, timeout) {
    const result = await client.Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout,
    });
    if (result.exceptionDetails) {
        throw new Error(`JS Error: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
}
export async function waitForSelector(client, selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const found = await evaluate(client, `document.querySelector('${selector}') !== null`);
        if (found)
            return;
        await sleep(200);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
}
export async function extractPuzzleImages(client) {
    return evaluate(client, `(async () => {
    const bgImg = document.getElementById('aliyunCaptcha-img');
    const pzImg = document.getElementById('aliyunCaptcha-puzzle');
    const imgBox = document.getElementById('aliyunCaptcha-img-box');
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');

    if (!bgImg || !pzImg) throw new Error('Puzzle images not found in DOM');

    function bytesToBase64(bytes) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode(...chunk);
      }
      return btoa(binary);
    }

    async function fetchImageAsBase64(imgEl) {
      const src = imgEl.currentSrc || imgEl.src;
      const width = imgEl.naturalWidth || imgEl.width || 0;
      const height = imgEl.naturalHeight || imgEl.height || 0;

      if (src.startsWith('data:')) {
        return { base64: src.split(',')[1], w: width, h: height };
      }

      const attempts = [
        () => fetch(src, { credentials: 'include' }),
        () => fetch(src, { mode: 'cors', credentials: 'include' }),
        () => fetch(src),
      ];

      let lastError = '';
      for (const run of attempts) {
        try {
          const resp = await run();
          if (!resp.ok) {
            lastError = 'HTTP ' + resp.status;
            continue;
          }
          const bytes = new Uint8Array(await resp.arrayBuffer());
          return {
            base64: bytesToBase64(bytes),
            w: width,
            h: height,
          };
        } catch (err) {
          lastError = String(err);
        }
      }

      throw new Error('Failed to fetch captcha image bytes: ' + lastError);
    }

    const [bg, pz] = await Promise.all([fetchImageAsBase64(bgImg), fetchImageAsBase64(pzImg)]);

    return {
      backgroundBase64: bg.base64,
      puzzleBase64: pz.base64,
      bgNaturalWidth: bg.w,
      bgNaturalHeight: bg.h,
      pzNaturalWidth: pz.w,
      pzNaturalHeight: pz.h,
      imgBoxRect: imgBox ? imgBox.getBoundingClientRect().toJSON() : { x: 0, y: 0, width: 0, height: 0 },
      sliderRect: slider ? slider.getBoundingClientRect().toJSON() : { x: 0, y: 0, width: 0, height: 0 },
    };
  })()`);
}
export async function clickTrigger(client) {
    const triggerRect = await evaluate(client, `(() => {
      const el = document.querySelector('#aliyunCaptcha-captcha-left')
              || document.querySelector('#aliyunCaptcha-captcha-text-box')
              || document.querySelector('#aliyunCaptcha-captcha-body');
      if (!el) throw new Error('Captcha trigger not found');
      return el.getBoundingClientRect().toJSON();
    })()`);
    const cx = triggerRect.x + triggerRect.width / 2;
    const cy = triggerRect.y + triggerRect.height / 2;
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cssPx(cx), y: cssPx(cy), pointerType: 'mouse' });
    await sleep(80 + Math.random() * 60);
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cssPx(cx), y: cssPx(cy), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(40 + Math.random() * 60);
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cssPx(cx), y: cssPx(cy), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
const DEFAULT_GESTURE_TUNING = {
    dispatchMode: 'sequential',
    useLiveCorrection: true,
    preserveTrackTiming: false,
    skipWarmupMoves: false,
    initialHoldMs: [80, 140],
    preCorrectionSettleMs: [24, 44],
    correctionMoveDelayMs: [16, 34],
    correctionReadDelayMs: [18, 38],
    preReleaseHoverMs: [80, 150],
    correctionMaxMoves: 7,
    correctionMaxStep: 8,
    correctionTolerance: 1.2,
    finalAlignMaxMoves: 2,
    finalAlignTrigger: 1.6,
    finalAlignTolerance: 0.45,
    finalAlignStepMax: 2,
    finalPointerJitterX: 0.6,
    finalPointerJitterY: 0.25,
    postReleaseObserveMs: 250,
    livePositionReadTimeoutMs: 1400,
};
const MAX_FINAL_PHASE_DISPATCH_MS = 900;
function summarizeDispatchTrace(trace) {
    if (trace.length === 0) {
        return {
            totalEvents: 0,
            moveEvents: 0,
            pressEvents: 0,
            releaseEvents: 0,
            totalSpanMs: 0,
            dispatchSpanMs: 0,
            maxGapMs: 0,
            maxDispatchCallMs: 0,
            avgDispatchCallMs: 0,
            longGapCount: 0,
        };
    }
    let maxGapMs = 0;
    let maxDispatchCallMs = 0;
    let totalDispatchCallMs = 0;
    let longGapCount = 0;
    for (let i = 0; i < trace.length; i++) {
        const callMs = trace[i].tsAfter - trace[i].tsBefore;
        maxDispatchCallMs = Math.max(maxDispatchCallMs, callMs);
        totalDispatchCallMs += callMs;
        if (i > 0) {
            const gap = trace[i].tsBefore - trace[i - 1].tsAfter;
            maxGapMs = Math.max(maxGapMs, gap);
            if (gap >= 250)
                longGapCount++;
        }
    }
    return {
        totalEvents: trace.length,
        moveEvents: trace.filter((event) => event.cdpType === 'mouseMoved').length,
        pressEvents: trace.filter((event) => event.cdpType === 'mousePressed').length,
        releaseEvents: trace.filter((event) => event.cdpType === 'mouseReleased').length,
        totalSpanMs: trace[trace.length - 1].tsAfter - trace[0].tsBefore,
        dispatchSpanMs: trace[trace.length - 1].tsBefore - trace[0].tsBefore,
        maxGapMs,
        maxDispatchCallMs,
        avgDispatchCallMs: Number((totalDispatchCallMs / trace.length).toFixed(3)),
        longGapCount,
    };
}
export async function dragSlider(client, tracks, startX, startY, targetPuzzleLeft, onReleased, tuning = DEFAULT_GESTURE_TUNING, onBeforeRelease) {
    const dispatchTrace = [];
    const pendingDispatches = [];
    const flushPendingDispatches = async () => {
        if (pendingDispatches.length === 0)
            return;
        const current = pendingDispatches.splice(0, pendingDispatches.length);
        await Promise.allSettled(current);
    };
    const recordDispatch = async (phase, payload, plannedTrackT, waitForAck = true) => {
        const entry = {
            seq: dispatchTrace.length + 1,
            phase,
            cdpType: payload.type,
            tsBefore: Date.now(),
            tsAfter: 0,
            x: payload.x,
            y: payload.y,
            buttons: payload.buttons,
            button: payload.button,
            plannedTrackT: plannedTrackT ?? null,
        };
        dispatchTrace.push(entry);
        const promise = client.Input.dispatchMouseEvent(payload).then(() => {
            entry.tsAfter = Date.now();
        });
        if (waitForAck) {
            await promise;
        }
        else {
            pendingDispatches.push(promise);
        }
        return entry;
    };
    const sliderRect = await evaluate(client, `(() => {
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    if (!slider) return { x: 0, y: 0, width: 0, height: 0, sliderLeftBefore: '' };
    const rect = slider.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, sliderLeftBefore: slider.style.left };
  })()`);
    if (sliderRect.width === 0) {
        return {
            sliderMoved: false,
            puzzleMoved: false,
            sliderLeftBefore: '',
            sliderLeftAfter: '',
            puzzleLeftAfter: '',
            sliderExists: false,
            mousedownFired: false,
            trackPoints: tracks.length,
            method: 'cdp',
            correctionApplied: false,
            correctionDelta: 0,
            correctionMoves: 0,
            fineTuneMoves: 0,
            gestureDurationMs: 0,
            preReleaseLivePosition: null,
            releasePointer: null,
            lastMoveToReleaseMs: null,
            previousMovePhaseBeforeRelease: null,
            releaseTimingBreakdown: null,
            finalPhaseDispatchDegraded: false,
            dispatchTrace,
            dispatchSummary: summarizeDispatchTrace(dispatchTrace),
        };
    }
    const sx = sliderRect.x + sliderRect.width / 2;
    const sy = sliderRect.y + sliderRect.height / 2;
    const prePressWarmupEnabled = String(process.env.SOLVER_PRE_PRESS_WARMUP ?? '1').trim() !== '0' &&
        tuning.preserveTrackTiming &&
        tuning.skipWarmupMoves;
    if (prePressWarmupEnabled) {
        const imageRect = await evaluate(client, `(() => {
      const image = document.getElementById('aliyunCaptcha-img-box') || document.getElementById('aliyunCaptcha-img');
      if (!image) return null;
      const rect = image.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`).catch(() => null);
        if (imageRect) {
            const warmupMoves = 28 + Math.floor(Math.random() * 10);
            const startX = imageRect.x + imageRect.width * (0.72 + Math.random() * 0.18);
            const startY = imageRect.y + imageRect.height + 12 + Math.random() * 12;
            const endX = sx + (Math.random() - 0.5) * 2;
            const endY = sy + (Math.random() - 0.5) * 2;
            for (let i = 0; i < warmupMoves; i++) {
                const progress = warmupMoves <= 1 ? 1 : i / (warmupMoves - 1);
                const eased = 1 - Math.pow(1 - progress, 2.4);
                const wobble = Math.sin(progress * Math.PI * 2) * (1.5 + Math.random() * 0.8);
                const x = startX + (endX - startX) * eased + (Math.random() - 0.5) * 1.4;
                const y = startY + (endY - startY) * eased + wobble + (Math.random() - 0.5) * 1.2;
                await sleep(12 + Math.random() * 9);
                await recordDispatch('approach', {
                    type: 'mouseMoved',
                    x: cssPx(x),
                    y: cssPx(y),
                    pointerType: 'mouse',
                });
            }
            await sleep(55 + Math.random() * 85);
        }
    }
    await recordDispatch('approach', { type: 'mouseMoved', x: cssPx(sx), y: cssPx(sy), pointerType: 'mouse' });
    await sleep(60 + Math.random() * 50);
    await recordDispatch('press', { type: 'mousePressed', x: cssPx(sx), y: cssPx(sy), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    const gestureStartedAt = Date.now();
    await sleep(randomBetween(tuning.initialHoldMs));
    const warmupMoves = tuning.skipWarmupMoves ? 0 : 2 + Math.floor(Math.random() * 2);
    let warmupX = sx;
    for (let i = 0; i < warmupMoves; i++) {
        warmupX += 1 + Math.random() * 1.6;
        await sleep(16 + Math.random() * 14);
        await recordDispatch('track', {
            type: 'mouseMoved',
            x: cssPx(warmupX),
            y: cssPx(sy + (Math.random() - 0.5) * 2.2),
            button: 'left',
            buttons: 1,
            pointerType: 'mouse',
        }, null, tuning.dispatchMode !== 'queued');
    }
    const densifyTrackMoves = tuning.dispatchMode === 'queued' && tuning.finalAlignMaxMoves === 0;
    const densifyCutoffIndex = Math.max(4, Math.floor(tracks.length * 0.72));
    const trackDispatchStartedAt = Date.now();
    for (let i = 0; i < tracks.length; i++) {
        const pt = tracks[i];
        const prevPt = i > 0 ? tracks[i - 1] : null;
        const prevT = i > 0 ? tracks[i - 1].t : 0;
        const delay = tuning.preserveTrackTiming
            ? Math.max(0, pt.t - (Date.now() - trackDispatchStartedAt))
            : Math.max(pt.t - prevT, 3);
        await sleep(delay);
        if (densifyTrackMoves && prevPt && i >= 2 && i < densifyCutoffIndex) {
            const dx = pt.x - prevPt.x;
            if (dx >= 7) {
                const ix = prevPt.x + dx * 0.5;
                const iy = prevPt.y + (pt.y - prevPt.y) * 0.5 + (Math.random() - 0.5) * 1.1;
                await sleep(2 + Math.random() * 4);
                await recordDispatch('track', {
                    type: 'mouseMoved',
                    x: cssPx(sx + ix),
                    y: cssPx(sy + iy),
                    button: 'left',
                    buttons: 1,
                    pointerType: 'mouse',
                }, prevPt.t + (pt.t - prevPt.t) * 0.5, tuning.dispatchMode !== 'queued');
            }
        }
        await recordDispatch('track', {
            type: 'mouseMoved',
            x: cssPx(sx + pt.x),
            y: cssPx(sy + pt.y),
            button: 'left',
            buttons: 1,
            pointerType: 'mouse',
        }, pt.t, tuning.dispatchMode !== 'queued');
        if (densifyTrackMoves && i >= 3 && i < densifyCutoffIndex) {
            await sleep(3 + Math.random() * 5);
            await recordDispatch('track', {
                type: 'mouseMoved',
                x: cssPx(sx + pt.x),
                y: cssPx(sy + pt.y + (Math.random() - 0.5) * 1.2),
                button: 'left',
                buttons: 1,
                pointerType: 'mouse',
            }, pt.t, tuning.dispatchMode !== 'queued');
        }
    }
    let correctionApplied = false;
    let correctionDelta = 0;
    let correctionMoves = 0;
    let fineTuneMoves = 0;
    let finalPhaseDispatchDegraded = false;
    let preReleaseLivePosition = null;
    let currentPointerX = sx + tracks[tracks.length - 1].x;
    let currentPointerY = sy + tracks[tracks.length - 1].y;
    const releaseTimingBreakdown = {
        pendingFlushBeforeCorrectionMs: 0,
        initialStabilityWaitMs: 0,
        preCorrectionSettleMs: 0,
        correctionLoopMs: 0,
        postCorrectionLiveReadMs: 0,
        finalStabilityWaitMs: 0,
        preReleaseHoverMs: 0,
        finalHoverDispatchMs: 0,
        beforeReleaseCallbackMs: 0,
        preReleaseRandomSleepMs: 0,
        releaseDispatchCallMs: 0,
        totalMeasuredBeforeReleaseMs: 0,
    };
    const readLivePosition = async () => {
        try {
            return await evaluateWithTimeout(client, `(() => {
        const puzzle = document.getElementById('aliyunCaptcha-puzzle');
        const slider = document.getElementById('aliyunCaptcha-sliding-slider');
        return {
          puzzleLeft: parseFloat(puzzle?.style.left || '0') || 0,
          sliderLeft: parseFloat(slider?.style.left || '0') || 0,
        };
      })()`, tuning.livePositionReadTimeoutMs);
        }
        catch {
            return null;
        }
    };
    const syncPointerToLiveSlider = (live) => {
        currentPointerX = sliderRect.x + live.sliderLeft + sliderRect.width / 2;
    };
    const waitForLivePositionStability = async (stableReadsRequired, maxWaitMs) => {
        let last = null;
        let stableReads = 0;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            const live = await readLivePosition();
            if (!live) {
                await sleep(12);
                continue;
            }
            if (last &&
                Math.abs(live.puzzleLeft - last.puzzleLeft) <= 0.35 &&
                Math.abs(live.sliderLeft - last.sliderLeft) <= 0.35) {
                stableReads++;
                if (stableReads >= stableReadsRequired) {
                    return live;
                }
            }
            else {
                stableReads = 0;
            }
            last = live;
            await sleep(12 + Math.random() * 8);
        }
        return last;
    };
    if (tuning.dispatchMode === 'queued' && !tuning.useLiveCorrection) {
        const flushStartedAt = Date.now();
        await flushPendingDispatches();
        releaseTimingBreakdown.pendingFlushBeforeCorrectionMs += Date.now() - flushStartedAt;
        const settleStartedAt = Date.now();
        const settledLive = await waitForLivePositionStability(1, 180);
        releaseTimingBreakdown.finalStabilityWaitMs += Date.now() - settleStartedAt;
        if (settledLive) {
            preReleaseLivePosition = settledLive;
            syncPointerToLiveSlider(settledLive);
        }
    }
    if (typeof targetPuzzleLeft === 'number' && tuning.useLiveCorrection) {
        const flushStartedAt = Date.now();
        await flushPendingDispatches();
        releaseTimingBreakdown.pendingFlushBeforeCorrectionMs += Date.now() - flushStartedAt;
        const initialStabilityStartedAt = Date.now();
        await waitForLivePositionStability(2, tuning.dispatchMode === 'queued' ? 320 : 180);
        releaseTimingBreakdown.initialStabilityWaitMs += Date.now() - initialStabilityStartedAt;
        const preCorrectionSettleMs = randomBetween(tuning.preCorrectionSettleMs);
        releaseTimingBreakdown.preCorrectionSettleMs += preCorrectionSettleMs;
        await sleep(preCorrectionSettleMs);
        const correctionLoopStartedAt = Date.now();
        for (let i = 0; i < tuning.correctionMaxMoves; i++) {
            const live = await readLivePosition();
            if (!live)
                break;
            syncPointerToLiveSlider(live);
            const delta = targetPuzzleLeft - live.puzzleLeft;
            correctionDelta = delta;
            if (Math.abs(delta) <= tuning.correctionTolerance) {
                break;
            }
            correctionApplied = true;
            correctionMoves++;
            const ratio = live.sliderLeft > 6 && live.puzzleLeft > 6
                ? live.puzzleLeft / live.sliderLeft
                : 1;
            const normalizedRatio = clamp(ratio, 0.55, 1.05);
            const predictedPointerDelta = delta / normalizedRatio;
            const maxStep = Math.abs(delta) > 20
                ? tuning.correctionMaxStep
                : Math.abs(delta) > 8
                    ? Math.max(3, tuning.correctionMaxStep - 2)
                    : Math.max(2, tuning.correctionMaxStep - 4);
            const step = Math.sign(predictedPointerDelta) * Math.min(Math.abs(predictedPointerDelta), maxStep);
            currentPointerX += step;
            await sleep(randomBetween(tuning.correctionMoveDelayMs));
            const dispatch = await recordDispatch('correction', {
                type: 'mouseMoved',
                x: cssPx(currentPointerX),
                y: cssPx(currentPointerY + (Math.random() * tuning.finalPointerJitterY * 4 - tuning.finalPointerJitterY * 2)),
                button: 'left',
                buttons: 1,
                pointerType: 'mouse',
            });
            if (dispatch.tsAfter - dispatch.tsBefore > MAX_FINAL_PHASE_DISPATCH_MS) {
                finalPhaseDispatchDegraded = true;
                break;
            }
            await sleep(randomBetween(tuning.correctionReadDelayMs));
        }
        releaseTimingBreakdown.correctionLoopMs += Date.now() - correctionLoopStartedAt;
        const postCorrectionReadStartedAt = Date.now();
        let live = await readLivePosition();
        releaseTimingBreakdown.postCorrectionLiveReadMs += Date.now() - postCorrectionReadStartedAt;
        if (!live) {
            correctionDelta = 0;
        }
        else {
            syncPointerToLiveSlider(live);
            correctionDelta = targetPuzzleLeft - live.puzzleLeft;
            for (let i = 0; i < tuning.finalAlignMaxMoves; i++) {
                if (finalPhaseDispatchDegraded) {
                    break;
                }
                if (Math.abs(correctionDelta) > tuning.finalAlignTrigger) {
                    break;
                }
                if (Math.abs(correctionDelta) <= tuning.finalAlignTolerance) {
                    break;
                }
                correctionApplied = true;
                fineTuneMoves++;
                const ratio = live.sliderLeft > 6 && live.puzzleLeft > 6
                    ? live.puzzleLeft / live.sliderLeft
                    : 1;
                const normalizedRatio = clamp(ratio, 0.6, 1.05);
                const predictedPointerDelta = correctionDelta / normalizedRatio;
                const step = Math.sign(predictedPointerDelta) * Math.max(1, Math.min(Math.abs(predictedPointerDelta), tuning.finalAlignStepMax));
                currentPointerX += step;
                await sleep(randomBetween(tuning.correctionMoveDelayMs));
                const dispatch = await recordDispatch('correction', {
                    type: 'mouseMoved',
                    x: cssPx(currentPointerX),
                    y: cssPx(currentPointerY + (Math.random() * tuning.finalPointerJitterY * 2.8 - tuning.finalPointerJitterY * 1.4)),
                    button: 'left',
                    buttons: 1,
                    pointerType: 'mouse',
                });
                if (dispatch.tsAfter - dispatch.tsBefore > MAX_FINAL_PHASE_DISPATCH_MS) {
                    finalPhaseDispatchDegraded = true;
                    break;
                }
                await sleep(randomBetween(tuning.correctionReadDelayMs));
                const nextLive = await readLivePosition();
                if (!nextLive)
                    break;
                live = nextLive;
                syncPointerToLiveSlider(live);
                correctionDelta = targetPuzzleLeft - live.puzzleLeft;
            }
        }
    }
    if (typeof targetPuzzleLeft === 'number' && tuning.useLiveCorrection && !finalPhaseDispatchDegraded) {
        const finalStabilityStartedAt = Date.now();
        const settledLive = await waitForLivePositionStability(1, tuning.dispatchMode === 'queued' ? 120 : 80);
        releaseTimingBreakdown.finalStabilityWaitMs += Date.now() - finalStabilityStartedAt;
        if (settledLive) {
            preReleaseLivePosition = settledLive;
            syncPointerToLiveSlider(settledLive);
        }
    }
    if (onBeforeRelease) {
        const beforeReleaseStartedAt = Date.now();
        await onBeforeRelease();
        releaseTimingBreakdown.beforeReleaseCallbackMs += Date.now() - beforeReleaseStartedAt;
    }
    currentPointerX += Math.random() * tuning.finalPointerJitterX;
    currentPointerY += Math.random() * tuning.finalPointerJitterY * 2 - tuning.finalPointerJitterY;
    if (!finalPhaseDispatchDegraded) {
        const preReleaseHoverMs = randomBetween(tuning.preReleaseHoverMs);
        releaseTimingBreakdown.preReleaseHoverMs += preReleaseHoverMs;
        await sleep(preReleaseHoverMs);
    }
    const shouldForceTightTailHover = typeof targetPuzzleLeft === 'number' &&
        tuning.dispatchMode === 'queued' &&
        tuning.preReleaseHoverMs[1] <= 20;
    const shouldDispatchFinalHover = shouldForceTightTailHover ||
        correctionApplied ||
        tuning.preReleaseHoverMs[1] > 20 ||
        tuning.finalPointerJitterX > 0.2 ||
        tuning.finalPointerJitterY > 0.2;
    if (shouldDispatchFinalHover) {
        if (shouldForceTightTailHover) {
            currentPointerY += Math.random() < 0.5 ? -1 : 1;
        }
        const finalHoverDispatch = await recordDispatch('final_hover', {
            type: 'mouseMoved',
            x: cssPx(currentPointerX),
            y: cssPx(currentPointerY),
            button: 'left',
            buttons: 1,
            pointerType: 'mouse',
        });
        releaseTimingBreakdown.finalHoverDispatchMs += finalHoverDispatch.tsAfter - finalHoverDispatch.tsBefore;
    }
    const preReleaseRandomSleepMs = 2 + Math.random() * 8;
    releaseTimingBreakdown.preReleaseRandomSleepMs += preReleaseRandomSleepMs;
    await sleep(preReleaseRandomSleepMs);
    const releaseDispatch = await recordDispatch('release', {
        type: 'mouseReleased',
        x: cssPx(currentPointerX),
        y: cssPx(currentPointerY),
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
    });
    releaseTimingBreakdown.releaseDispatchCallMs = releaseDispatch.tsAfter - releaseDispatch.tsBefore;
    releaseTimingBreakdown.totalMeasuredBeforeReleaseMs =
        releaseTimingBreakdown.pendingFlushBeforeCorrectionMs +
            releaseTimingBreakdown.initialStabilityWaitMs +
            releaseTimingBreakdown.preCorrectionSettleMs +
            releaseTimingBreakdown.correctionLoopMs +
            releaseTimingBreakdown.postCorrectionLiveReadMs +
            releaseTimingBreakdown.finalStabilityWaitMs +
            releaseTimingBreakdown.preReleaseHoverMs +
            releaseTimingBreakdown.finalHoverDispatchMs +
            releaseTimingBreakdown.beforeReleaseCallbackMs +
            releaseTimingBreakdown.preReleaseRandomSleepMs;
    const previousMoveBeforeRelease = dispatchTrace
        .filter((event) => event.seq < releaseDispatch.seq && event.cdpType === 'mouseMoved' && event.tsAfter > 0)
        .at(-1) || null;
    if (onReleased) {
        await onReleased();
    }
    await sleep(tuning.postReleaseObserveMs);
    await flushPendingDispatches();
    const after = await evaluate(client, `(() => {
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    const puzzle = document.getElementById('aliyunCaptcha-puzzle');
    return {
      sliderLeftAfter: slider?.style.left || '',
      puzzleLeftAfter: puzzle?.style.left || '',
    };
  })()`);
    return {
        sliderMoved: parseFloat(after.sliderLeftAfter) > 2,
        puzzleMoved: parseFloat(after.puzzleLeftAfter) > 2,
        sliderLeftBefore: sliderRect.sliderLeftBefore,
        sliderLeftAfter: after.sliderLeftAfter,
        puzzleLeftAfter: after.puzzleLeftAfter,
        sliderExists: true,
        mousedownFired: true,
        trackPoints: tracks.length,
        method: 'cdp',
        correctionApplied,
        correctionDelta,
        correctionMoves,
        fineTuneMoves,
        gestureDurationMs: dispatchTrace[dispatchTrace.length - 1]?.tsBefore
            ? dispatchTrace[dispatchTrace.length - 1].tsBefore - gestureStartedAt
            : 0,
        preReleaseLivePosition,
        releasePointer: {
            x: cssPx(currentPointerX),
            y: cssPx(currentPointerY),
        },
        lastMoveToReleaseMs: previousMoveBeforeRelease
            ? Math.max(0, releaseDispatch.tsBefore - previousMoveBeforeRelease.tsAfter)
            : null,
        previousMovePhaseBeforeRelease: previousMoveBeforeRelease?.phase || null,
        releaseTimingBreakdown,
        finalPhaseDispatchDegraded,
        dispatchTrace,
        dispatchSummary: summarizeDispatchTrace(dispatchTrace),
    };
}
export async function getCertifyId(client) {
    return evaluate(client, `(() => {
    const el = document.getElementById('captcha-element');
    if (!el) return '';
    const text = el.innerText || el.textContent || '';
    const m = text.match(/CertifyId[^A-Za-z0-9]*([A-Za-z0-9]{6,})/i);
    if (m) return m[1];
    const allSpans = el.querySelectorAll('span, div, p');
    for (const s of allSpans) {
      const t = s.textContent || '';
      const m2 = t.match(/CertifyId[^A-Za-z0-9]*([A-Za-z0-9]{6,})/i);
      if (m2) return m2[1];
    }
    return '';
  })()`);
}
export async function checkCaptchaResult(client, prevCertifyId) {
    return evaluate(client, `((prevCertifyId) => {
    const captchaText = document.querySelector('#aliyunCaptcha-captcha-text')?.textContent || '';
    const fullState = document.getElementById('captcha-element')?.innerText?.substring(0, 800) || '';
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    const puzzle = document.getElementById('aliyunCaptcha-puzzle');
    const body = document.querySelector('#aliyunCaptcha-captcha-body');
    const bodyCls = body?.className || '';
    const verifyResponses = window.__verifyCaptchaResponses || [];
    const extractVerifyMeta = (rawBody) => {
      const text = String(rawBody || '');
      const verifyCodeMatch = text.match(/"VerifyCode"\\s*:\\s*"([^"]+)"/i);
      const certifyIdMatch =
        text.match(/"certifyId"\\s*:\\s*"([^"]+)"/i) ||
        text.match(/"CertifyId"\\s*:\\s*"([^"]+)"/i);
      const verifyResultMatch = text.match(/"VerifyResult"\\s*:\\s*(true|false)/i);
      return {
        verifyCode: verifyCodeMatch ? String(verifyCodeMatch[1] || '').trim().toUpperCase() : null,
        certifyId: certifyIdMatch ? String(certifyIdMatch[1] || '').trim() : null,
        verifyResult: verifyResultMatch ? String(verifyResultMatch[1] || '').toLowerCase() === 'true' : null,
      };
    };
    const verifyCode = (() => {
      for (let i = verifyResponses.length - 1; i >= 0; i--) {
        const meta = extractVerifyMeta(verifyResponses[i]?.body || '');
        if (prevCertifyId && meta.certifyId && meta.certifyId !== prevCertifyId) continue;
        if (meta.verifyCode) return meta.verifyCode;
      }
      return null;
    })();

    const sliderLeft = slider?.style.left || '0px';
    const puzzleLeft = puzzle?.style.left || '0px';
    const sliderMoved = sliderLeft !== '' && sliderLeft !== '0px' && parseFloat(sliderLeft) > 2;
    const puzzleMoved = puzzleLeft !== '' && puzzleLeft !== '0px' && parseFloat(puzzleLeft) > 2;

    const certifyMatch = fullState.match(/CertifyId:\\s*([A-Za-z0-9]+)/);
    const currentCertifyId = certifyMatch ? certifyMatch[1] : '';
    const certifyIdChanged = prevCertifyId !== '' && currentCertifyId !== '' && prevCertifyId !== currentCertifyId;

    const lowState = fullState.toLowerCase();
    const hasFailureMessage =
      lowState.includes('failed') ||
      lowState.includes('fail') ||
      lowState.includes('error') ||
      lowState.includes('retry') ||
      lowState.includes('timed out') ||
      lowState.includes('try again') ||
      lowState.includes('verification failed');

    const timedOut =
      lowState.includes('timed out') ||
      lowState.includes('close and retry');

    const hasSuccessClass =
      bodyCls.includes('success') ||
      bodyCls.includes('verified') ||
      document.querySelector('.aliyunCaptcha-success, [class*="success-icon"]') !== null ||
      lowState.includes('verification successful') ||
      lowState.includes('verified');

    const hookSuccess = !!window.__captchaSuccess;
    const verifyResponseSuccess = verifyResponses.some((entry) => {
      const meta = extractVerifyMeta(entry?.body || '');
      if (prevCertifyId && meta.certifyId && meta.certifyId !== prevCertifyId) {
        return false;
      }
      const text = String(entry?.body || '').toLowerCase();
      return (
        meta.verifyResult === true ||
        meta.verifyCode === 'T001' ||
        text.includes('"securitytoken"')
      );
    }) || verifyCode === 'T001';

    const success =
      sliderMoved &&
      puzzleMoved &&
      !certifyIdChanged &&
      !hasFailureMessage &&
      (hasSuccessClass || hookSuccess || verifyResponseSuccess);

    let failureReason = null;
    if (timedOut) {
      failureReason = 'timed_out';
    } else if (hasFailureMessage) {
      failureReason = 'verification_failed';
    } else if (certifyIdChanged) {
      failureReason = 'certify_id_changed';
    }

    return {
      success,
      captchaText,
      fullState,
      captchaVerifyParam: window.__capturedCaptchaParam || null,
      verifyCode,
      sliderMoved,
      puzzleMoved,
      certifyIdChanged,
      currentCertifyId,
      hasSuccessClass,
      hasFailureMessage,
      timedOut,
      failureReason,
      hookSuccess,
      verifyResponseSuccess,
    };
  })(\`${prevCertifyId.replace(/`/g, '\\`')}\`)`);
}
function buildCaptchaHookScript(options = {}) {
    const captureFullDragTrace = options.captureFullDragTrace
        ?? parseBooleanEnvFlag(process.env.SOLVER_CAPTURE_DRAG_EVENT_TRACE, false);
    return `(() => {
  const HOOK_VERSION = 8;
  const CAPTURE_FULL_DRAG_TRACE = ${captureFullDragTrace ? 'true' : 'false'};
  const HOOK_MODE = CAPTURE_FULL_DRAG_TRACE ? 'full' : 'light';
  if (window.__captchaHookVersion === HOOK_VERSION && window.__captchaHookDragTraceMode === HOOK_MODE) return;
  try {
    if (Array.isArray(window.__captchaHookListeners)) {
      for (const entry of window.__captchaHookListeners) {
        try {
          document.removeEventListener(entry.type, entry.listener, !!entry.capture);
        } catch (e) {}
      }
    }
  } catch (e) {}
  window.__captchaHookVersion = HOOK_VERSION;
  window.__captchaHookDragTraceMode = HOOK_MODE;
  window.__captchaHookInstalled = true;
  window.__captchaHookListeners = [];
  window.__capturedCaptchaParam = null;
  window.__captchaSuccess = false;
  window.__captchaCallLog = [];
  window.__verifyCaptchaResponses = [];
  window.__verifyCaptchaRequests = [];
  window.__captchaDragEvents = [];
  window.__captchaReleaseSnapshot = null;
  window.__captchaReleaseSnapshots = [];
  window.__captchaReleaseCounter = 0;
  window.__captchaReleaseLogicalCounter = 0;
  window.__captchaLastReleaseLogical = null;
  window.__captchaLastLogSignature = null;
  window.__captchaHumanDrag = {
    cycle: 0,
    armed: false,
    started: false,
    active: false,
    released: false,
    startTs: null,
    endTs: null,
    startType: null,
    endType: null,
    startEvent: null,
    releaseEvent: null,
    events: [],
  };

  window.__resetCaptchaObservation = function() {
    try {
      const prevCycle = Number(window.__captchaHumanDrag?.cycle || 0);
      window.__capturedCaptchaParam = null;
      window.__captchaSuccess = false;
      window.__captchaCallLog = [];
      window.__verifyCaptchaResponses = [];
      window.__verifyCaptchaRequests = [];
      window.__captchaLastLogSignature = null;
      window.__captchaDragEvents = [];
      window.__captchaReleaseSnapshot = null;
      window.__captchaReleaseSnapshots = [];
      window.__captchaReleaseCounter = 0;
      window.__captchaReleaseLogicalCounter = 0;
      window.__captchaLastReleaseLogical = null;
      window.__captchaHumanDrag = {
        cycle: prevCycle + 1,
        armed: true,
        started: false,
        active: false,
        released: false,
        startTs: null,
        endTs: null,
        startType: null,
        endType: null,
        startEvent: null,
        releaseEvent: null,
        events: [],
      };
    } catch (e) {}
  };

  const pushLog = (entry) => {
    try {
      const signature = JSON.stringify({
        event: entry?.event || '',
        paramLen: entry?.paramLen || 0,
        err: entry?.err || '',
        url: entry?.url || '',
      });
      const now = Date.now();
      const last = window.__captchaLastLogSignature;
      if (last && last.signature === signature && now - last.ts < 250) {
        return;
      }
      window.__captchaLastLogSignature = { signature, ts: now };
      window.__captchaCallLog.push(entry);
    } catch (e) {}
  };

  const bodyToText = (body) => {
    try {
      if (typeof body === 'string') return body;
      if (body == null) return '';
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.toString();
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        body.forEach((value, key) => {
          parts.push(key + '=' + (typeof value === 'string' ? value : '[blob]'));
        });
        return parts.join('&');
      }
      if (typeof body === 'object') {
        const plain = {};
        for (const key of Object.getOwnPropertyNames(body)) {
          try {
            plain[key] = body[key];
          } catch (e) {}
        }
        const json = JSON.stringify(plain);
        if (json && json !== '{}') return json;
      }
      if (typeof body === 'object' && typeof body.toString === 'function' && body.toString !== Object.prototype.toString) {
        const text = body.toString();
        if (text && text !== '[object Object]') return text;
      }
      return JSON.stringify(body);
    } catch (e) {
      try {
        return String(body);
      } catch (e2) {
        return '';
      }
    }
  };

  const parseFormLike = (text) => {
    try {
      if (!text || typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
      if (!/[=&]/.test(text)) return null;
      const params = new URLSearchParams(text);
      const result = {};
      for (const [key, value] of params.entries()) {
        if (!(key in result)) {
          result[key] = value;
        }
      }
      return Object.keys(result).length ? result : null;
    } catch (e) {
      return null;
    }
  };

  const summarizeJsonPayload = (text) => {
    try {
      if (!text || typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return {
        keys: Object.keys(parsed).slice(0, 20),
        code: parsed.Result?.VerifyCode || parsed.Code || parsed.code || parsed.VerifyCode || null,
        message: parsed.Message || parsed.message || null,
        success:
          typeof parsed.Result?.VerifyResult === 'boolean'
            ? parsed.Result.VerifyResult
            : typeof parsed.Success === 'boolean'
            ? parsed.Success
            : typeof parsed.success === 'boolean'
              ? parsed.success
              : null,
        verifyCode: parsed.Result?.VerifyCode || parsed.VerifyCode || null,
        verifyResult: typeof parsed.Result?.VerifyResult === 'boolean' ? parsed.Result.VerifyResult : null,
        certifyId: parsed.Result?.certifyId || parsed.CertifyId || parsed.certifyId || null,
        captchaType: parsed.CaptchaType || parsed.captchaType || null,
      };
    } catch (e) {
      return null;
    }
  };

  const isCaptchaRelated = (url, text) => {
    try {
      const haystack = String(url || '') + '\\n' + String(text || '');
      const low = haystack.toLowerCase();
      const lowUrl = String(url || '').toLowerCase();
      if (
        lowUrl.includes('rum.aliyuncs.com') ||
        lowUrl.includes('/api/config') ||
        lowUrl.includes('analytics.google.com') ||
        lowUrl.includes('log.aliyuncs.com')
      ) {
        return false;
      }
      return (
        low.includes('captcha-open') ||
        low.includes('upload.captcha') ||
        low.includes('cloudauth-device') ||
        low.includes('certifyid') ||
        low.includes('captchaverifyparam') ||
        low.includes('verifycaptchav3') ||
        low.includes('initcaptchav3') ||
        low.includes('action=log1') ||
        low.includes('action=log2') ||
        low.includes('action=log3') ||
        low.includes('action=uploadlog') ||
        low.includes('action=verifycaptchav3')
      );
    } catch (e) {
      return false;
    }
  };

  const inspectCaptchaVerifyParam = (text) => {
    try {
      if (!text || typeof text !== 'string') return null;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      const shortHash = (value) => {
        try {
          if (!value || typeof value !== 'string') return null;
          let hash = 2166136261;
          for (let i = 0; i < value.length; i++) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
          }
          return (hash >>> 0).toString(16).padStart(8, '0');
        } catch (e) {
          return null;
        }
      };
      return {
        sceneId: parsed.sceneId || null,
        certifyId: parsed.certifyId || null,
        deviceTokenLength: typeof parsed.deviceToken === 'string' ? parsed.deviceToken.length : 0,
        dataLength: typeof parsed.data === 'string' ? parsed.data.length : 0,
        deviceTokenHash: shortHash(parsed.deviceToken),
        dataHash: shortHash(parsed.data),
        hasDeviceToken: !!parsed.deviceToken,
        hasData: !!parsed.data,
        keys: Object.keys(parsed).slice(0, 20),
      };
    } catch (e) {
      return null;
    }
  };

  const recordVerifyRequest = (url, body, source) => {
    try {
      const text = bodyToText(body);
      if (!isCaptchaRelated(url, text)) return;
      const form = parseFormLike(text);
      const captchaVerifyParamInfo = inspectCaptchaVerifyParam(form?.CaptchaVerifyParam || '');
      if (typeof form?.CaptchaVerifyParam === 'string' && form.CaptchaVerifyParam) {
        window.__capturedCaptchaParam = form.CaptchaVerifyParam;
        pushLog({ event: source + '_form_param', ts: Date.now(), url, paramLen: form.CaptchaVerifyParam.length });
      }
      window.__verifyCaptchaRequests.push({
        ts: Date.now(),
        source,
        url,
        body: text.slice(0, 2000),
        form,
        captchaVerifyParamInfo,
        jsonSummary: summarizeJsonPayload(text),
        stack: String(new Error().stack || '').split('\\n').slice(0, 8).join('\\n'),
      });
      if (window.__verifyCaptchaRequests.length > 100) {
        window.__verifyCaptchaRequests = window.__verifyCaptchaRequests.slice(-100);
      }
    } catch (e) {}
  };

  const capturePossibleParam = (payload, source, url = '') => {
    try {
      let parsed = payload;
      if (typeof payload === 'string') {
        const trimmed = payload.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            parsed = JSON.parse(trimmed);
          } catch (e) {}
        }
      }

      const visit = (value) => {
        if (!value) return null;
        if (typeof value === 'string') {
          if (value.includes('captcha_verify_param')) return value;
          return null;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = visit(item);
            if (found) return found;
          }
          return null;
        }
        if (typeof value === 'object') {
          if (value.captcha_verify_param) {
            return typeof value.captcha_verify_param === 'string'
              ? value.captcha_verify_param
              : JSON.stringify(value.captcha_verify_param);
          }
          for (const key of Object.keys(value)) {
            const found = visit(value[key]);
            if (found) return found;
          }
        }
        return null;
      };

      const found = visit(parsed);
      if (found) {
        window.__capturedCaptchaParam = found;
        pushLog({ event: source, ts: Date.now(), url, paramLen: String(found).length });
      }
    } catch (e) {}
  };

  const recordVerifyResponse = (url, status, body, source) => {
    try {
      const text = bodyToText(body);
      if (!isCaptchaRelated(url, text)) {
        capturePossibleParam(body, source + '_response', url);
        return;
      }
      const form = parseFormLike(text);
      window.__verifyCaptchaResponses.push({
        ts: Date.now(),
        source,
        status,
        url,
        body: text.slice(0, 1000),
        form,
        jsonSummary: summarizeJsonPayload(text),
        stack: String(new Error().stack || '').split('\\n').slice(0, 8).join('\\n'),
      });
      capturePossibleParam(body, source + '_response', url);
    } catch (e) {}
  };

  const captureReleaseSnapshot = (pointer, type, phase, logicalReleaseId) => {
    try {
      const slider = document.getElementById('aliyunCaptcha-sliding-slider');
      const puzzle = document.getElementById('aliyunCaptcha-puzzle');
      const imgBox = document.getElementById('aliyunCaptcha-img-box');
      const bgImg = document.getElementById('aliyunCaptcha-img');
      const win = document.getElementById('aliyunCaptcha-window-float');
      const banner = document.querySelector('#aliyunCaptcha-sliding-text, .aliyunCaptcha-errorTip, .aliyunCaptcha-error-text');
      const snapshot = {
        type,
        phase,
        logicalReleaseId,
        releaseIndex: (window.__captchaReleaseCounter = (window.__captchaReleaseCounter || 0) + 1),
        ts: Date.now(),
        perfNow: typeof performance !== 'undefined' ? performance.now() : 0,
        pointer: {
          x: Number(pointer?.x || 0),
          y: Number(pointer?.y || 0),
          button: Number(pointer?.button || 0),
          buttons: Number(pointer?.buttons || 0),
          isTrusted: !!pointer?.isTrusted,
        },
        sliderLeft: slider?.style.left || '',
        puzzleLeft: puzzle?.style.left || '',
        sliderClass: String(slider?.className || '').slice(0, 200),
        puzzleClass: String(puzzle?.className || '').slice(0, 200),
        windowClass: String(win?.className || '').slice(0, 200),
        sliderRect: slider?.getBoundingClientRect?.().toJSON?.() || null,
        puzzleRect: puzzle?.getBoundingClientRect?.().toJSON?.() || null,
        imgBoxRect: imgBox?.getBoundingClientRect?.().toJSON?.() || null,
        backgroundRect: bgImg?.getBoundingClientRect?.().toJSON?.() || null,
        windowRect: win?.getBoundingClientRect?.().toJSON?.() || null,
        statusText: String(banner?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
      window.__captchaReleaseSnapshot = snapshot;
      window.__captchaReleaseSnapshots.push(snapshot);
      if (window.__captchaReleaseSnapshots.length > 60) {
        window.__captchaReleaseSnapshots = window.__captchaReleaseSnapshots.slice(-60);
      }
    } catch (e) {}
  };

  const scheduleReleaseSnapshots = (event, type) => {
    try {
      const now = Date.now();
      const pointer = {
        x: Number(event?.clientX || 0),
        y: Number(event?.clientY || 0),
        button: Number(event?.button || 0),
        buttons: Number(event?.buttons || 0),
        isTrusted: !!event?.isTrusted,
      };
      const last = window.__captchaLastReleaseLogical || null;
      const sameLogicalRelease = !!(
        last &&
        now - Number(last.ts || 0) < 80 &&
        Math.abs(Number(last.x || 0) - pointer.x) <= 2 &&
        Math.abs(Number(last.y || 0) - pointer.y) <= 2
      );
      const logicalReleaseId = sameLogicalRelease
        ? Number(last.id || 0)
        : (window.__captchaReleaseLogicalCounter = (window.__captchaReleaseLogicalCounter || 0) + 1);
      window.__captchaLastReleaseLogical = { id: logicalReleaseId, ts: now, x: pointer.x, y: pointer.y, type };
      if (sameLogicalRelease) {
        return;
      }
      captureReleaseSnapshot(pointer, type, 'event', logicalReleaseId);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => captureReleaseSnapshot(pointer, type, 'raf', logicalReleaseId));
      }
      setTimeout(() => captureReleaseSnapshot(pointer, type, 't+80ms', logicalReleaseId), 80);
      setTimeout(() => captureReleaseSnapshot(pointer, type, 't+180ms', logicalReleaseId), 180);
    } catch (e) {}
  };

  const addTrackedDocumentListener = (type, listener, capture = true) => {
    document.addEventListener(type, listener, capture);
    try {
      window.__captchaHookListeners.push({ type, listener, capture: !!capture });
    } catch (e) {}
  };

  const wrapCaptchaInit = (origInit) => {
    if (typeof origInit !== 'function') return origInit;
    const wrappedInit = function(config) {
      try {
        pushLog({ event: 'init', ts: Date.now() });
      } catch (e) {}

      const origSuccess = config.success;
      config.success = function(param) {
        try {
          const captured = typeof param === 'string' ? param : JSON.stringify(param);
          window.__capturedCaptchaParam = captured;
          window.__captchaSuccess = true;
          pushLog({ event: 'success', ts: Date.now(), paramLen: captured.length });
        } catch (e) {}
        if (origSuccess) return origSuccess.apply(this, arguments);
      };

      const origFail = config.fail;
      config.fail = function(err) {
        try {
          window.__captchaSuccess = false;
          pushLog({ event: 'fail', ts: Date.now(), err: bodyToText(err).slice(0, 600) });
        } catch (e) {}
        if (origFail) return origFail.apply(this, arguments);
      };

      const origError = config.onError;
      config.onError = function(err) {
        try {
          pushLog({ event: 'error', ts: Date.now(), err: bodyToText(err).slice(0, 600) });
        } catch (e) {}
        if (origError) return origError.apply(this, arguments);
      };

      return origInit.apply(this, arguments);
    };
    wrappedInit.__captchaHookWrapped = true;
    wrappedInit.__captchaHookSource = origInit;
    return wrappedInit;
  };

  const hookInit = () => {
    const activeInit = window.initAliyunCaptcha;
    const sourceInit =
      typeof window.__captchaOrigInitAliyunCaptcha === 'function'
        ? window.__captchaOrigInitAliyunCaptcha
        : typeof window.__origInitAliyunCaptcha === 'function'
          ? window.__origInitAliyunCaptcha
          : typeof activeInit === 'function'
            ? (activeInit.__captchaHookSource || activeInit)
            : null;
    if (typeof sourceInit !== 'function') return false;
    const wrappedInit = wrapCaptchaInit(sourceInit);
    window.__captchaOrigInitAliyunCaptcha = sourceInit;
    window.__captchaWrappedInitAliyunCaptcha = wrappedInit;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'initAliyunCaptcha');
    if (descriptor && (descriptor.get || descriptor.set)) {
      return true;
    }
    window.initAliyunCaptcha = wrappedInit;
    return true;
  };

  if (!hookInit()) {
    Object.defineProperty(window, 'initAliyunCaptcha', {
      configurable: true,
      get() { return window.__captchaWrappedInitAliyunCaptcha || window.__captchaOrigInitAliyunCaptcha || null; },
      set(fn) {
        window.__origInitAliyunCaptcha = fn;
        window.__captchaOrigInitAliyunCaptcha =
          typeof fn === 'function' ? (fn.__captchaHookSource || fn) : fn;
        window.__captchaWrappedInitAliyunCaptcha =
          typeof window.__captchaOrigInitAliyunCaptcha === 'function'
            ? wrapCaptchaInit(window.__captchaOrigInitAliyunCaptcha)
            : window.__captchaOrigInitAliyunCaptcha;
      }
    });
  }

  const origFetch = window.__captchaOrigFetch || window.fetch;
  window.__captchaOrigFetch = origFetch;
  window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    try {
      const init = args[1] || {};
      if (init.body != null) {
        recordVerifyRequest(url, init.body, 'fetch');
      }
      if (typeof init.body === 'string') {
        capturePossibleParam(init.body, 'fetch_request', url);
      }
    } catch (e) {}

    return origFetch.apply(this, args).then(async (resp) => {
      try {
        const clone = resp.clone();
        const text = await clone.text();
        recordVerifyResponse(url, resp.status, text, 'fetch');
      } catch (e) {}
      return resp;
    });
  };

  const origOpen = XMLHttpRequest.prototype.__captchaOrigOpen || XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.__captchaOrigSend || XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.__captchaOrigOpen = origOpen;
  XMLHttpRequest.prototype.__captchaOrigSend = origSend;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__captchaUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      if (body != null) {
        recordVerifyRequest(this.__captchaUrl || '', body, 'xhr');
      }
      if (typeof body === 'string') {
        capturePossibleParam(body, 'xhr_request', this.__captchaUrl || '');
      }
      this.addEventListener('load', function() {
        try {
          recordVerifyResponse(this.__captchaUrl || '', this.status, this.responseText || '', 'xhr');
        } catch (e) {}
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  if (CAPTURE_FULL_DRAG_TRACE) {
    const dragTypes = ['mousedown', 'mousemove', 'mouseup', 'pointerdown', 'pointermove', 'pointerup'];
    for (const type of dragTypes) {
      addTrackedDocumentListener(type, (event) => {
        try {
          const win = document.getElementById('aliyunCaptcha-window-float');
          const slider = document.getElementById('aliyunCaptcha-sliding-slider');
          const puzzle = document.getElementById('aliyunCaptcha-puzzle');
          if (!win) return;
          const isMoveEvent = type === 'pointermove' || type === 'mousemove';
          const rect = win.getBoundingClientRect();
          const x = Number(event.clientX || 0);
          const y = Number(event.clientY || 0);
          const insideRect = x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4;
          if (!insideRect) return;
          const path = !isMoveEvent && typeof event.composedPath === 'function'
            ? event.composedPath().slice(0, 4).map((node) => {
                if (!node) return 'null';
                if (node === window) return 'window';
                if (node === document) return 'document';
                return node.id || node.className || node.nodeName || typeof node;
              })
            : [];
          const sliderRect = isMoveEvent ? null : slider?.getBoundingClientRect?.();
          const puzzleRect = isMoveEvent ? null : puzzle?.getBoundingClientRect?.();
          const onSlider = !!(
            sliderRect &&
            x >= sliderRect.left - 3 &&
            x <= sliderRect.right + 3 &&
            y >= sliderRect.top - 3 &&
            y <= sliderRect.bottom + 3
          );
          const onPuzzle = !!(
            puzzleRect &&
            x >= puzzleRect.left - 3 &&
            x <= puzzleRect.right + 3 &&
            y >= puzzleRect.top - 3 &&
            y <= puzzleRect.bottom + 3
          );
          const dragEntry = {
            type,
            ts: Date.now(),
            x,
            y,
            isTrusted: !!event.isTrusted,
            button: Number(event.button || 0),
            buttons: Number(event.buttons || 0),
            target: isMoveEvent ? '' : event.target?.id || event.target?.className || event.target?.nodeName || '',
            path,
            sliderLeft: slider?.style.left || '',
            puzzleLeft: puzzle?.style.left || '',
            onSlider,
            onPuzzle,
          };
          window.__captchaDragEvents.push(dragEntry);
          if (window.__captchaDragEvents.length > 1000) {
            window.__captchaDragEvents = window.__captchaDragEvents.slice(-1000);
          }
          const human = window.__captchaHumanDrag;
          if (human?.armed) {
            const startCandidate =
              (type === 'pointerdown' || type === 'mousedown') &&
              (onSlider || onPuzzle || path.some((value) => String(value || '').includes('aliyunCaptcha-sliding-slider') || String(value || '').includes('aliyunCaptcha-puzzle')));
            const moveCandidate =
              (type === 'pointermove' || type === 'mousemove') &&
              Number(event.buttons || 0) === 1;
            const releaseCandidate = type === 'pointerup' || type === 'mouseup';
            if (!human.active && !human.released && startCandidate) {
              human.started = true;
              human.active = true;
              human.startTs = dragEntry.ts;
              human.startType = type;
              human.startEvent = { ...dragEntry, phase: 'drag_start' };
              human.events = [{ ...dragEntry, phase: 'drag_start' }];
            } else if (human.active && moveCandidate) {
              human.events.push({ ...dragEntry, phase: 'drag_move' });
              if (human.events.length > 800) {
                human.events = human.events.slice(-800);
              }
            } else if (human.active && releaseCandidate) {
              human.active = false;
              human.released = true;
              human.endTs = dragEntry.ts;
              human.endType = type;
              human.releaseEvent = { ...dragEntry, phase: 'drag_release' };
              human.events.push({ ...dragEntry, phase: 'drag_release' });
            }
          }
          if (type === 'mouseup' || type === 'pointerup') {
            scheduleReleaseSnapshots(event, type);
          }
        } catch (e) {}
      }, true);
    }
  } else {
    for (const type of ['mouseup', 'pointerup']) {
      addTrackedDocumentListener(type, (event) => {
        try {
          scheduleReleaseSnapshots(event, type);
        } catch (e) {}
      }, true);
    }
  }
})();`;
}
export async function installCaptchaHook(client, options = {}) {
    const script = buildCaptchaHookScript(options);
    try {
        await client.Page.addScriptToEvaluateOnNewDocument({ source: script });
    }
    catch { }
    await evaluate(client, script);
}
export async function captureScreenshot(client, clip) {
    const normalizedClip = clip && clip.width > 0 && clip.height > 0
        ? {
            x: Math.max(0, clip.x),
            y: Math.max(0, clip.y),
            width: Math.max(1, clip.width),
            height: Math.max(1, clip.height),
            scale: clip.scale && clip.scale > 0 ? clip.scale : 1,
        }
        : undefined;
    const result = await client.Page.captureScreenshot({
        format: 'png',
        fromSurface: true,
        ...(normalizedClip ? { clip: normalizedClip } : {}),
    });
    return Buffer.from(result.data, 'base64');
}
export async function captureElementScreenshot(client, selector) {
    const rect = await evaluate(client, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
    if (!rect)
        return null;
    return captureScreenshot(client, rect);
}
export async function readCapturedParam(client) {
    return evaluate(client, `({
      param: window.__capturedCaptchaParam || null,
      success: !!window.__captchaSuccess,
      log: window.__captchaCallLog || [],
    })`);
}
export async function readCaptchaNetworkTrace(client) {
    const traced = client;
    const state = traced.__captchaNetworkTrace;
    return {
        requests: state?.requests.slice(-30) || [],
        responses: state?.responses.slice(-30) || [],
    };
}
export function resetCaptchaNetworkTrace(client) {
    const traced = client;
    const state = traced.__captchaNetworkTrace;
    if (!state)
        return;
    state.requests = [];
    state.responses = [];
    state.trackedRequestIds.clear();
    state.responseMeta.clear();
    state.requestGeneration.clear();
    state.generation++;
}
export async function resetCaptchaObservation(client) {
    await evaluate(client, `(() => {
    if (typeof window.__resetCaptchaObservation === 'function') {
      window.__resetCaptchaObservation();
      return true;
    }
    window.__capturedCaptchaParam = null;
    window.__captchaSuccess = false;
    window.__captchaCallLog = [];
    window.__verifyCaptchaResponses = [];
    window.__verifyCaptchaRequests = [];
    window.__captchaDragEvents = [];
    window.__captchaReleaseSnapshot = null;
    window.__captchaReleaseSnapshots = [];
    window.__captchaReleaseCounter = 0;
    window.__captchaReleaseLogicalCounter = 0;
    window.__captchaLastReleaseLogical = null;
    window.__captchaLastLogSignature = null;
    window.__captchaHumanDrag = {
      cycle: 1,
      armed: true,
      started: false,
      active: false,
      released: false,
      startTs: null,
      endTs: null,
      startType: null,
      endType: null,
      startEvent: null,
      releaseEvent: null,
      events: [],
    };
    return true;
  })()`);
    resetCaptchaNetworkTrace(client);
}
export async function interceptCaptchaParam(client) {
    return evaluate(client, `new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (window.__capturedCaptchaParam) {
        resolve(window.__capturedCaptchaParam);
        return;
      }
      const el = document.getElementById('captcha-element');
      const body = document.querySelector('#aliyunCaptcha-captcha-body');
      const cls = body?.className || '';
      const text = el?.innerText || '';
      if (cls.includes('success') || text.includes('verification successful') || text.includes('Success')) {
        resolve('__SUCCESS_NO_PARAM__');
        return;
      }
      if (Date.now() - start > 10000) {
        resolve(null);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  })`);
}
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=cdp.js.map