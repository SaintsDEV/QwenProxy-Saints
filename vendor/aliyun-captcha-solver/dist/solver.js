import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCDP, evaluate, clickTrigger, extractPuzzleImages, dragSlider, checkCaptchaResult, readCapturedParam, readCaptchaNetworkTrace, installCaptchaHook, getCertifyId, sleep, captureScreenshot, resetCaptchaObservation, resetCaptchaNetworkTrace } from './cdp.js';
import { estimateSliderTravelX } from './slider-travel.js';
import { templateMatch } from './vision.js';
import { generateHumanTrack, resolveGestureProfile, resolveGestureTuning } from './trajectory.js';
import { classifyCaptchaEvent, isSuccessfulAttemptOutcome, resolveVerifyCode } from './captcha-flow.js';
function log(verbose, ...args) {
    if (verbose)
        console.log('[solver]', ...args);
}
function envValue(names) {
    for (const name of names) {
        const value = process.env[name];
        if (value)
            return value;
    }
    return undefined;
}
function envEnabled(...names) {
    const value = envValue(names);
    if (!value)
        return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}
function resolveCaptchaOpenMode(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/-/g, '_');
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
    const resolved = aliases[raw || 'captcha_only'];
    if (!resolved) {
        throw new Error('captchaOpenMode must be one of: captcha_only, open_if_needed');
    }
    return resolved;
}
async function closeExistingCaptchaWindow(client, verbose, reason) {
    const state = await evaluate(client, `(() => {
    const win = document.getElementById('aliyunCaptcha-window-float');
    const winVisible = !!(win && !String(win.className || '').includes('window-hidden'));
    return {
      windowVisible: winVisible,
      hasClose: !!document.getElementById('aliyunCaptcha-btn-close'),
      text: String(document.getElementById('aliyunCaptcha-sliding-text')?.textContent || ''),
    };
  })()`);
    if (!state.windowVisible || !state.hasClose) {
        return false;
    }
    log(verbose, `Closing existing captcha before fresh attempt (${reason})`);
    await evaluate(client, `(() => {
    const btn = document.getElementById('aliyunCaptcha-btn-close');
    if (btn) btn.click();
  })()`);
    const closed = await evaluate(client, `new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const win = document.getElementById('aliyunCaptcha-window-float');
      const visible = !!(win && !String(win.className || '').includes('window-hidden'));
      if (!visible) return resolve(true);
      if (Date.now() - start > 2500) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  })`);
    if (!closed) {
        log(verbose, 'Existing captcha did not close cleanly before fresh attempt');
    }
    await sleep(300);
    return closed;
}
async function readCaptchaReadiness(client) {
    return evaluate(client, `(() => {
    const visibleRect = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const imageReady = (el) => {
      if (!el) return false;
      const img = el;
      return visibleRect(img) && !!(img.currentSrc || img.src) && img.complete !== false && (img.naturalWidth || 0) > 0 && (img.naturalHeight || 0) > 0;
    };

    const win = document.getElementById('aliyunCaptcha-window-float');
    const imgBox = document.getElementById('aliyunCaptcha-img-box');
    const bg = document.getElementById('aliyunCaptcha-img');
    const puzzle = document.getElementById('aliyunCaptcha-puzzle');
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    const text = String(document.getElementById('aliyunCaptcha-sliding-text')?.textContent || '').replace(/\\s+/g, ' ').trim();
    const windowVisible = !!(win && !String(win.className || '').includes('window-hidden') && visibleRect(win));
    const state = {
      ready: false,
      windowVisible,
      sliderVisible: visibleRect(slider),
      imageBoxVisible: visibleRect(imgBox),
      backgroundReady: imageReady(bg),
      puzzleReady: imageReady(puzzle),
      timedOut: /timed out|close and retry/i.test(text),
      text,
      missing: [],
    };
    if (!state.windowVisible) state.missing.push('window');
    if (!state.imageBoxVisible) state.missing.push('imageBox');
    if (!state.backgroundReady) state.missing.push('background');
    if (!state.puzzleReady) state.missing.push('puzzle');
    if (!state.sliderVisible) state.missing.push('slider');
    state.ready = !state.timedOut && state.missing.length === 0;
    return state;
  })()`);
}
async function waitForPuzzleReady(client, timeout) {
    const start = Date.now();
    let lastState = null;
    while (Date.now() - start < timeout) {
        lastState = await readCaptchaReadiness(client);
        if (lastState.ready)
            return lastState;
        if (lastState.timedOut) {
            throw new Error(`Captcha timed out while waiting for puzzle readiness: ${lastState.text || 'no status text'}`);
        }
        await sleep(200);
    }
    const details = lastState
        ? `missing=${lastState.missing.join(',') || 'none'} text="${lastState.text}"`
        : 'no widget state captured';
    throw new Error(`Puzzle did not become ready within ${timeout}ms (${details})`);
}
async function ensureCaptchaTriggerAvailable(client, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let clickedEmailLogin = false;
    while (Date.now() < deadline) {
        const state = await evaluate(client, `(() => {
      const trigger = document.querySelector(
        '#aliyunCaptcha-captcha-left, #aliyunCaptcha-captcha-text-box, #aliyunCaptcha-captcha-body'
      );
      if (trigger) {
        return { hasTrigger: true, hasEmailLoginChoice: false, clickedEmailLogin: false };
      }

      const candidateGroups = [
        Array.from(document.querySelectorAll('button')),
        Array.from(document.querySelectorAll('[role="button"], a')),
        Array.from(document.querySelectorAll('div, span')),
      ];
      let emailChoice = null;
      for (const candidates of candidateGroups) {
        emailChoice = candidates.find((el) => {
          const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            /^continue\\s+with\\s+email$/i.test(text) &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.pointerEvents !== 'none'
          );
        });
        if (emailChoice) break;
      }
      if (emailChoice) {
        emailChoice.click();
        return { hasTrigger: false, hasEmailLoginChoice: true, clickedEmailLogin: true };
      }
      return { hasTrigger: false, hasEmailLoginChoice: false, clickedEmailLogin: false };
    })()`);
        if (state.hasTrigger)
            return true;
        clickedEmailLogin ||= state.clickedEmailLogin;
        await sleep(clickedEmailLogin ? 400 : 200);
    }
    return false;
}
function analyzeMatchQuality(match) {
    const top = match.scores[0]?.score;
    const competing = match.scores.find((score) => Math.abs(score.x - match.x) > 10);
    const competingScore = competing?.score;
    const topGap = typeof top === 'number' && typeof competingScore === 'number'
        ? Number((top - competingScore).toFixed(4))
        : null;
    const topRatio = typeof top === 'number' && typeof competingScore === 'number' && Math.abs(top) > 0.0001
        ? Number((competingScore / top).toFixed(4))
        : null;
    const componentXs = [match.contourX, match.edgeX, match.gapX, match.nccX]
        .filter((value) => Number.isFinite(value) && value >= 0);
    const componentEntries = [
        { name: 'contour', x: match.contourX },
        { name: 'edge', x: match.edgeX },
        { name: 'gap', x: match.gapX },
        { name: 'ncc', x: match.nccX },
    ].filter((entry) => Number.isFinite(entry.x) && entry.x >= 0);
    const componentSpread = componentXs.length >= 2
        ? Math.max(...componentXs) - Math.min(...componentXs)
        : null;
    const componentsNearFinal = componentEntries.filter((entry) => Math.abs(entry.x - match.x) <= 8);
    const reasons = [];
    if (match.confidence < 0.58)
        reasons.push('low_confidence');
    if (topRatio !== null && topRatio > 0.965)
        reasons.push('close_second_score');
    if (topGap !== null && topGap < 0.025)
        reasons.push('small_top_gap');
    if (componentSpread !== null && componentSpread > 55 && componentsNearFinal.length < 2) {
        reasons.push('component_disagreement');
    }
    for (let i = 0; i < componentEntries.length; i++) {
        for (let j = i + 1; j < componentEntries.length; j++) {
            const left = componentEntries[i];
            const right = componentEntries[j];
            const clusterX = (left.x + right.x) / 2;
            if (Math.abs(left.x - right.x) <= 4 &&
                Math.abs(clusterX - match.x) > 8 &&
                match.confidence < 0.9) {
                reasons.push(`split_component_cluster:${left.name}+${right.name}`);
                i = componentEntries.length;
                break;
            }
        }
    }
    return {
        ambiguous: reasons.length > 0,
        reasons,
        topGap,
        topRatio,
        competingX: competing?.x ?? null,
        componentSpread,
        componentXs,
    };
}
function summarizeDragTelemetry(page) {
    const events = Array.isArray(page?.dragEvents) ? page.dragEvents : [];
    const uniqueKeys = new Set();
    let duplicateAdjacent = 0;
    let prevKey = '';
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let firstDownTs = null;
    let lastMoveTs = null;
    let releaseTs = null;
    let pointerMoveCount = 0;
    let mouseMoveCount = 0;
    for (const event of events) {
        const key = [
            event?.type,
            event?.ts,
            event?.x,
            event?.y,
            event?.buttons,
            event?.sliderLeft,
            event?.puzzleLeft,
        ].join('|');
        if (key === prevKey)
            duplicateAdjacent++;
        prevKey = key;
        uniqueKeys.add(key);
        const isPressedMove = (event?.type === 'pointermove' || event?.type === 'mousemove') &&
            Number(event?.buttons || 0) === 1;
        if (isPressedMove && typeof event?.y === 'number') {
            minY = Math.min(minY, event.y);
            maxY = Math.max(maxY, event.y);
        }
        if ((event?.type === 'pointerdown' || event?.type === 'mousedown') && typeof event?.ts === 'number') {
            firstDownTs ??= event.ts;
        }
        if (isPressedMove && typeof event?.ts === 'number') {
            lastMoveTs = event.ts;
        }
        if ((event?.type === 'pointerup' || event?.type === 'mouseup') && typeof event?.ts === 'number') {
            releaseTs = event.ts;
        }
        if (event?.type === 'pointermove')
            pointerMoveCount++;
        if (event?.type === 'mousemove')
            mouseMoveCount++;
    }
    const releases = Array.isArray(page?.releaseSnapshots) ? page.releaseSnapshots : [];
    const logicalIds = new Set(releases
        .map((entry) => entry?.logicalReleaseId)
        .filter((value) => typeof value === 'number'));
    return {
        rawCount: events.length,
        uniqueCount: uniqueKeys.size,
        pointerMoveCount,
        mouseMoveCount,
        duplicateAdjacent,
        releaseSnapshotCount: releases.length,
        logicalReleaseCount: logicalIds.size || (releases.length ? 1 : 0),
        yRange: Number.isFinite(minY) && Number.isFinite(maxY) ? Number((maxY - minY).toFixed(3)) : null,
        dragDurationMs: firstDownTs !== null && releaseTs !== null ? releaseTs - firstDownTs : null,
        lastMoveToReleaseMs: lastMoveTs !== null && releaseTs !== null ? releaseTs - lastMoveTs : null,
    };
}
async function readCaptchaChallengeSignature(client) {
    const dom = await evaluate(client, `(() => ({
    certifyId: String(document.body?.innerText || '').match(/CertifyId:\\s*([A-Za-z0-9]+)/)?.[1] || '',
    backgroundSrc: String(document.getElementById('aliyunCaptcha-img')?.currentSrc || document.getElementById('aliyunCaptcha-img')?.src || ''),
    puzzleSrc: String(document.getElementById('aliyunCaptcha-puzzle')?.currentSrc || document.getElementById('aliyunCaptcha-puzzle')?.src || ''),
  }))()`);
    if (dom.certifyId)
        return dom;
    return {
        ...dom,
        certifyId: await getCertifyId(client).catch(() => ''),
    };
}
async function refreshCaptchaChallenge(client, verbose, reason, timeout) {
    const before = await readCaptchaChallengeSignature(client);
    const beforeCertifyId = before.certifyId;
    const refreshRect = await evaluate(client, `(() => {
    const candidates = [
      '#aliyunCaptcha-btn-refresh',
      '#aliyunCaptcha-refresh',
      '[id*="refresh"]',
      '[class*="refresh"]',
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return null;
  })()`);
    if (!refreshRect) {
        return false;
    }
    log(verbose, `Refreshing captcha challenge (${reason}, previous=${beforeCertifyId || 'n/a'})`);
    const cx = Math.round(refreshRect.x + refreshRect.width / 2);
    const cy = Math.round(refreshRect.y + refreshRect.height / 2);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: cx, y: cy, pointerType: 'mouse' });
    await sleep(70 + Math.random() * 50);
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(35 + Math.random() * 45);
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    const start = Date.now();
    let lastCertifyId = beforeCertifyId;
    let lastImageSignature = `${before.backgroundSrc}|${before.puzzleSrc}`;
    while (Date.now() - start < timeout) {
        const readiness = await readCaptchaReadiness(client);
        const current = await readCaptchaChallengeSignature(client);
        const currentCertifyId = current.certifyId;
        const currentImageSignature = `${current.backgroundSrc}|${current.puzzleSrc}`;
        if (currentCertifyId)
            lastCertifyId = currentCertifyId;
        if (currentImageSignature)
            lastImageSignature = currentImageSignature;
        const beforeImageSignature = `${before.backgroundSrc}|${before.puzzleSrc}`;
        const hadBeforeSignature = !!(before.certifyId || before.backgroundSrc || before.puzzleSrc);
        const certifyIdChanged = !!currentCertifyId && currentCertifyId !== beforeCertifyId;
        const imagesChanged = !!currentImageSignature && currentImageSignature !== beforeImageSignature;
        const freshEnough = certifyIdChanged || imagesChanged || !hadBeforeSignature;
        if (readiness.ready && freshEnough) {
            log(verbose, `Captcha refresh ready: ${beforeCertifyId || 'n/a'} -> ${currentCertifyId || 'n/a'}${imagesChanged ? ' (images changed)' : ''}`);
            return true;
        }
        if (readiness.timedOut) {
            throw new Error(`Captcha timed out during refresh: ${readiness.text || 'no status text'}`);
        }
        await sleep(200);
    }
    throw new Error(`Captcha refresh did not produce a fresh challenge (${beforeCertifyId || 'n/a'} -> ${lastCertifyId || 'n/a'}, images=${lastImageSignature ? 'present' : 'missing'})`);
}
async function reloadCurrentPage(client) {
    await evaluate(client, `location.reload()`);
    await sleep(2500);
}
export async function solve(options = {}) {
    const { host = '127.0.0.1', port = 9222, targetUrl = '/auth?response_type=code', captchaOpenMode: captchaOpenModeOption, maxRetries = 3, tolerance = 5, verbose = true, waitForPuzzleTimeout = 15000, debugScreenshots: debugScreenshotsOption, debugDir: debugDirOption, targetOffset: targetOffsetOption, targetBias: targetBiasOption, gestureProfile: gestureProfileOption, reuseOpenCaptcha: reuseOpenCaptchaOption, captureFullDragTrace: captureFullDragTraceOption, } = options;
    log(verbose, `Connecting to CDP at ${host}:${port} (target: ${targetUrl})...`);
    const client = await connectCDP(host, port, targetUrl);
    let lastError = '';
    const captchaOpenMode = resolveCaptchaOpenMode(captchaOpenModeOption || process.env.SOLVER_CAPTCHA_OPEN_MODE || 'captcha_only');
    const debugScreenshots = debugScreenshotsOption ?? envEnabled('DEBUG_SCREENSHOTS', 'SOLVER_DEBUG_SCREENSHOTS');
    const debugRoot = debugDirOption || envValue(['DEBUG_DIR', 'SOLVER_DEBUG_DIR']) || 'screenshots';
    const debugRunId = new Date().toISOString().replace(/[:.]/g, '-');
    const debugDir = path.resolve(process.cwd(), debugRoot, debugRunId);
    const runStartedAt = Date.now();
    const targetOffset = targetOffsetOption ?? envNumber('SOLVER_TARGET_OFFSET', 0);
    const targetBias = targetBiasOption ?? envNumber('SOLVER_TARGET_BIAS', 1);
    const gestureProfile = resolveGestureProfile(gestureProfileOption || process.env.SOLVER_GESTURE_PROFILE || 'human_replay');
    const gestureTuning = resolveGestureTuning(gestureProfile);
    const reuseOpenCaptcha = reuseOpenCaptchaOption ?? envEnabled('SOLVER_REUSE_OPEN_CAPTCHA');
    const captureFullDragTrace = captureFullDragTraceOption ?? (envValue(['SOLVER_CAPTURE_DRAG_EVENT_TRACE'])
        ? envEnabled('SOLVER_CAPTURE_DRAG_EVENT_TRACE')
        : !envEnabled('SOLVER_LIGHT_DRAG_TRACE'));
    const usedCertifyIds = new Set();
    const preparedCertifyIds = new Set();
    let attemptsRun = 0;
    const collectDebugContext = async () => {
        const page = await evaluate(client, `(() => {
      const styleInfo = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName || '',
          id: el.id || '',
          className: String(el.className || '').slice(0, 200),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          position: style.position,
          zIndex: style.zIndex,
          transform: style.transform,
          overflow: style.overflow,
          pointerEvents: style.pointerEvents,
          backgroundColor: style.backgroundColor,
        };
      };
      const inspect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) {
          return {
            selector,
            present: false,
            visible: false,
            rect: null,
            className: '',
            text: '',
          };
        }
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          selector,
          present: true,
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          className: String(el.className || '').slice(0, 200),
          text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        };
      };
      const largeLayers = Array.from(document.querySelectorAll('*'))
        .map(styleInfo)
        .filter((item) => item && item.rect.width > window.innerWidth * 0.45 && item.rect.height > window.innerHeight * 0.45)
        .filter((item) => ['fixed', 'absolute', 'sticky'].includes(item.position) || item.zIndex !== 'auto')
        .slice(0, 30);

      return {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
        bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
        elements: {
          trigger: inspect('#aliyunCaptcha-captcha-left, #aliyunCaptcha-captcha-text-box, #aliyunCaptcha-captcha-body'),
          window: inspect('#aliyunCaptcha-window-float'),
          imageBox: inspect('#aliyunCaptcha-img-box'),
          background: inspect('#aliyunCaptcha-img'),
          puzzle: inspect('#aliyunCaptcha-puzzle'),
          slider: inspect('#aliyunCaptcha-sliding-slider'),
          overlay: inspect('#aliyunCaptcha-overlay'),
          windowWrapper: inspect('#aliyunCaptcha-float-wrapper'),
          captchaWrapper: inspect('#aliyunCaptcha-captcha-wrapper'),
          refresh: inspect('#aliyunCaptcha-btn-refresh, #aliyunCaptcha-refresh, [id*="refresh"], [class*="refresh"]'),
        },
        layout: {
          html: styleInfo(document.documentElement),
          body: styleInfo(document.body),
          largeLayers,
        },
        verifyResponses: (window.__verifyCaptchaResponses || []).slice(-5),
        verifyRequests: (window.__verifyCaptchaRequests || []).slice(-10),
        dragEvents: (window.__captchaDragEvents || []).slice(-1000),
        releaseSnapshot: window.__captchaReleaseSnapshot || null,
        releaseSnapshots: (window.__captchaReleaseSnapshots || []).slice(-12),
      };
    })()`);
        const captured = await readCapturedParam(client);
        const network = await readCaptchaNetworkTrace(client);
        return {
            page,
            hook: {
                paramCaptured: !!captured.param,
                paramLength: captured.param ? captured.param.length : 0,
                success: captured.success,
                logTail: captured.log.slice(-10),
            },
            network,
        };
    };
    const writeRunManifest = async () => {
        if (!debugScreenshots)
            return;
        await mkdir(debugDir, { recursive: true });
        await writeFile(path.join(debugDir, 'run.json'), JSON.stringify({
            runId: debugRunId,
            startedAt: new Date(runStartedAt).toISOString(),
            options: {
                host,
                port,
                targetUrl,
                captchaOpenMode,
                maxRetries,
                tolerance,
                verbose,
                waitForPuzzleTimeout,
            },
            debug: {
                root: debugRoot,
                targetOffset,
                targetBias,
                gestureProfile,
                gestureTuning,
                captureFullDragTrace,
            },
            env: {
                DEBUG_SCREENSHOTS: process.env.DEBUG_SCREENSHOTS || null,
                DEBUG_DIR: process.env.DEBUG_DIR || null,
                SOLVER_DEBUG_SCREENSHOTS: process.env.SOLVER_DEBUG_SCREENSHOTS || null,
                SOLVER_DEBUG_DIR: process.env.SOLVER_DEBUG_DIR || null,
            },
        }, null, 2), 'utf8');
    };
    const saveDebugShot = async (name, extra) => {
        if (!debugScreenshots)
            return;
        await mkdir(debugDir, { recursive: true });
        let png = null;
        let context = null;
        let screenshotError = null;
        let contextError = null;
        try {
            png = await captureScreenshot(client);
        }
        catch (err) {
            screenshotError = err instanceof Error ? err.message : String(err);
        }
        try {
            context = await collectDebugContext();
        }
        catch (err) {
            contextError = err instanceof Error ? err.message : String(err);
        }
        const base = `${String(Date.now())}-${name}`;
        if (png) {
            await writeFile(path.join(debugDir, `${base}.png`), png);
        }
        await writeFile(path.join(debugDir, `${base}.json`), JSON.stringify({
            step: name,
            capturedAt: new Date().toISOString(),
            elapsedMs: Date.now() - runStartedAt,
            debugDir,
            screenshotSaved: !!png,
            screenshotError,
            contextError,
            context,
            extra: extra || null,
        }, null, 2), 'utf8');
        log(verbose, `Saved debug screenshot: ${path.join(debugDir, `${base}.png`)}`);
    };
    const collectDragTelemetryForDebug = async () => {
        if (!debugScreenshots)
            return null;
        try {
            const context = await collectDebugContext();
            return summarizeDragTelemetry(context.page);
        }
        catch {
            return null;
        }
    };
    try {
        log(verbose, 'Installing captcha callback hook...');
        await installCaptchaHook(client, { captureFullDragTrace });
        await resetCaptchaObservation(client);
        resetCaptchaNetworkTrace(client);
        if (debugScreenshots) {
            await writeRunManifest();
            log(verbose, `Debug screenshots enabled: ${debugDir}`);
            await saveDebugShot('initial');
        }
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            attemptsRun = attempt;
            log(verbose, `--- Attempt ${attempt}/${maxRetries} ---`);
            const attemptStartedAt = Date.now();
            await resetCaptchaObservation(client);
            resetCaptchaNetworkTrace(client);
            let triggerWasClicked = false;
            let certifyIdBeforeOpening = await getCertifyId(client).catch(() => '');
            const existingCaptcha = await evaluate(client, `(() => {
        const win = document.getElementById('aliyunCaptcha-window-float');
        const slider = document.getElementById('aliyunCaptcha-sliding-slider');
        const text = document.getElementById('aliyunCaptcha-sliding-text')?.textContent || '';
        const winVisible = !!(win && !String(win.className || '').includes('window-hidden'));
        const sr = slider?.getBoundingClientRect();
        return {
          windowVisible: winVisible,
          sliderVisible: !!(sr && sr.width > 0 && sr.height > 0),
          timedOut: /timed out|close and retry/i.test(text),
          hasClose: !!document.getElementById('aliyunCaptcha-btn-close'),
        };
      })()`);
            if (existingCaptcha.windowVisible && existingCaptcha.sliderVisible && !existingCaptcha.timedOut && captchaOpenMode === 'captcha_only') {
                log(verbose, 'Using already-open captcha challenge (captcha_only mode)');
            }
            else if (existingCaptcha.windowVisible && !reuseOpenCaptcha && existingCaptcha.sliderVisible && !existingCaptcha.timedOut) {
                const currentCertifyId = await getCertifyId(client).catch(() => '');
                if (currentCertifyId && preparedCertifyIds.has(currentCertifyId) && !usedCertifyIds.has(currentCertifyId)) {
                    log(verbose, `Using prepared fresh captcha ${currentCertifyId}`);
                }
                else {
                    if (currentCertifyId)
                        usedCertifyIds.add(currentCertifyId);
                    const refreshed = await refreshCaptchaChallenge(client, verbose, 'existing-open-challenge', waitForPuzzleTimeout);
                    if (refreshed) {
                        const preparedCertifyId = await getCertifyId(client).catch(() => '');
                        if (preparedCertifyId)
                            preparedCertifyIds.add(preparedCertifyId);
                        await resetCaptchaObservation(client);
                    }
                    else if (existingCaptcha.hasClose) {
                        await closeExistingCaptchaWindow(client, verbose, 'refresh-unavailable');
                    }
                }
            }
            else if (captchaOpenMode !== 'captcha_only' &&
                existingCaptcha.windowVisible &&
                existingCaptcha.hasClose &&
                (!reuseOpenCaptcha || !existingCaptcha.sliderVisible || existingCaptcha.timedOut)) {
                const reason = existingCaptcha.timedOut
                    ? 'timed-out'
                    : existingCaptcha.sliderVisible
                        ? 'fresh-open-required'
                        : 'incomplete';
                if (existingCaptcha.timedOut) {
                    const refreshed = await refreshCaptchaChallenge(client, verbose, reason, waitForPuzzleTimeout).catch(() => false);
                    if (refreshed) {
                        const preparedCertifyId = await getCertifyId(client).catch(() => '');
                        if (preparedCertifyId)
                            preparedCertifyIds.add(preparedCertifyId);
                    }
                    else {
                        await closeExistingCaptchaWindow(client, verbose, reason);
                        log(verbose, 'Reloading page after timed-out captcha could not refresh');
                        await reloadCurrentPage(client);
                    }
                }
                else {
                    await closeExistingCaptchaWindow(client, verbose, reason);
                }
                await resetCaptchaObservation(client);
            }
            const puzzleAlreadyOpen = await evaluate(client, `!!(
        (() => {
          const slider = document.getElementById('aliyunCaptcha-sliding-slider');
          const imgBox = document.getElementById('aliyunCaptcha-img-box');
          const win = document.getElementById('aliyunCaptcha-window-float');
          const sr = slider?.getBoundingClientRect();
          const ir = imgBox?.getBoundingClientRect();
          return !!(
            win &&
            !String(win.className || '').includes('window-hidden') &&
            sr && ir &&
            sr.width > 0 && sr.height > 0 &&
            ir.width > 0 && ir.height > 0
          );
        })()
      )`);
            if (puzzleAlreadyOpen) {
                log(verbose, 'Captcha already open, skipping trigger click');
            }
            else if (captchaOpenMode === 'captcha_only') {
                log(verbose, 'Captcha is not fully ready yet, waiting without clicking trigger (captcha_only mode)');
                await saveDebugShot(`attempt-${attempt}-captcha-waiting-open`, {
                    attempt,
                    existingCaptcha,
                });
            }
            else {
                const hasTrigger = await ensureCaptchaTriggerAvailable(client, waitForPuzzleTimeout);
                if (!hasTrigger) {
                    throw new Error('Captcha is not open and trigger was not found on the current page');
                }
                log(verbose, 'Clicking captcha trigger...');
                const triggerClickStartedAt = Date.now();
                await clickTrigger(client);
                triggerWasClicked = true;
                await saveDebugShot(`attempt-${attempt}-after-trigger-click`, {
                    attempt,
                    triggerClickDurationMs: Date.now() - triggerClickStartedAt,
                    certifyIdBeforeOpening,
                });
            }
            log(verbose, 'Waiting for puzzle to load...');
            const puzzleWaitStartedAt = Date.now();
            let readiness;
            try {
                readiness = await waitForPuzzleReady(client, waitForPuzzleTimeout);
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                if (captchaOpenMode === 'captcha_only') {
                    lastError = `${lastError}. Click "click to start verification" first, wait for the captcha window to open, then call the API again.`;
                }
                await saveDebugShot(`attempt-${attempt}-puzzle-not-ready`, {
                    attempt,
                    error: lastError,
                });
                log(verbose, `Puzzle not ready: ${lastError}`);
                await closeExistingCaptchaWindow(client, verbose, 'puzzle-not-ready').catch(() => false);
                if (captchaOpenMode === 'captcha_only') {
                    break;
                }
                if (attempt < maxRetries) {
                    continue;
                }
                break;
            }
            log(verbose, `Puzzle ready: text="${readiness.text || 'n/a'}"`);
            let readyCertifyId = await getCertifyId(client).catch(() => '');
            if (triggerWasClicked &&
                readyCertifyId &&
                certifyIdBeforeOpening &&
                readyCertifyId === certifyIdBeforeOpening &&
                !reuseOpenCaptcha) {
                log(verbose, `Captcha opened with pre-existing hidden CertifyId ${readyCertifyId}, refreshing before drag`);
                const refreshed = await refreshCaptchaChallenge(client, verbose, 'pre-existing-hidden-certify-id', waitForPuzzleTimeout);
                if (refreshed) {
                    await resetCaptchaObservation(client);
                    await waitForPuzzleReady(client, waitForPuzzleTimeout);
                    readyCertifyId = await getCertifyId(client).catch(() => '');
                    certifyIdBeforeOpening = readyCertifyId;
                }
                else {
                    log(verbose, 'Pre-existing hidden CertifyId could not refresh before drag');
                }
            }
            if (readyCertifyId && usedCertifyIds.has(readyCertifyId) && !reuseOpenCaptcha) {
                log(verbose, `Captcha reused stale CertifyId ${readyCertifyId}, refreshing before drag`);
                await refreshCaptchaChallenge(client, verbose, 'stale-certify-id-before-drag', waitForPuzzleTimeout);
                await resetCaptchaObservation(client);
                await waitForPuzzleReady(client, waitForPuzzleTimeout);
                readyCertifyId = await getCertifyId(client).catch(() => '');
            }
            const sliderVisible = await evaluate(client, `(() => {
        const slider = document.getElementById('aliyunCaptcha-sliding-slider');
        const rect = slider?.getBoundingClientRect();
        return !!(rect && rect.width > 0 && rect.height > 0);
      })()`);
            if (!sliderVisible) {
                throw new Error('Slider became unavailable after captcha open');
            }
            await saveDebugShot(`attempt-${attempt}-puzzle-open`, {
                attempt,
                puzzleWaitDurationMs: Date.now() - puzzleWaitStartedAt,
            });
            await sleep(500 + Math.random() * 500);
            log(verbose, 'Extracting puzzle images...');
            const imageExtractStartedAt = Date.now();
            const images = await extractPuzzleImages(client);
            if (images.sliderRect.width <= 0 || images.sliderRect.height <= 0) {
                throw new Error('Slider rect is invalid after puzzle extraction');
            }
            log(verbose, `BG: ${images.bgNaturalWidth}x${images.bgNaturalHeight}, PZ: ${images.pzNaturalWidth}x${images.pzNaturalHeight}`);
            log(verbose, `Slider: (${images.sliderRect.x}, ${images.sliderRect.y})`);
            log(verbose, `Image box: (${images.imgBoxRect.x}, ${images.imgBoxRect.y}, w=${images.imgBoxRect.width})`);
            const bgBuffer = Buffer.from(images.backgroundBase64, 'base64');
            const pzBuffer = Buffer.from(images.puzzleBase64, 'base64');
            log(verbose, 'Running template matching...');
            const matchStartedAt = Date.now();
            const match = await templateMatch(bgBuffer, pzBuffer);
            log(verbose, `Best X: ${match.x}px (confidence: ${(match.confidence * 100).toFixed(1)}%)`);
            log(verbose, `Top 5 scores:`, match.scores.slice(0, 5).map(s => `x=${s.x}(${s.score.toFixed(1)})`).join(', '));
            log(verbose, `Component Xs: contour=${match.contourX}, edge=${match.edgeX}, gap=${match.gapX}, ncc=${match.nccX}`);
            const matchQuality = analyzeMatchQuality(match);
            if (matchQuality.ambiguous) {
                log(verbose, `Match quality ambiguous: ${matchQuality.reasons.join(', ')} (spread=${matchQuality.componentSpread ?? 'n/a'}, topRatio=${matchQuality.topRatio ?? 'n/a'})`);
                await saveDebugShot(`attempt-${attempt}-ambiguous-match`, {
                    attempt,
                    match,
                    matchQuality,
                    preDragCertifyId: readyCertifyId || await getCertifyId(client).catch(() => ''),
                });
                lastError = `Ambiguous puzzle target: ${matchQuality.reasons.join(', ')}`;
                if (!reuseOpenCaptcha) {
                    usedCertifyIds.add(readyCertifyId || await getCertifyId(client).catch(() => ''));
                    if (attempt < maxRetries) {
                        const refreshed = await refreshCaptchaChallenge(client, verbose, 'ambiguous-match', waitForPuzzleTimeout).catch(() => false);
                        if (refreshed) {
                            const preparedCertifyId = await getCertifyId(client).catch(() => '');
                            if (preparedCertifyId)
                                preparedCertifyIds.add(preparedCertifyId);
                        }
                        continue;
                    }
                }
                break;
            }
            const scaleX = images.imgBoxRect.width / images.bgNaturalWidth;
            const targetDisplayX = Math.max(0, Math.round(match.targetLeftX * scaleX + targetOffset + targetBias));
            const targetSliderTravelX = estimateSliderTravelX(targetDisplayX, gestureProfile, 'bot');
            log(verbose, `Scale: ${scaleX.toFixed(4)}, Target display X: ${targetDisplayX}px, slider travel X: ${targetSliderTravelX}px (match=${match.x}, targetLeft=${match.targetLeftX}, offset=${targetOffset}, bias=${targetBias})`);
            const sliderCenterX = images.sliderRect.x + images.sliderRect.width / 2;
            const sliderCenterY = images.sliderRect.y + images.sliderRect.height / 2;
            log(verbose, `Generating human track for ${targetSliderTravelX}px...`);
            const tracks = generateHumanTrack(targetSliderTravelX, gestureProfile);
            log(verbose, `Track[${gestureProfile}]: ${tracks.length} points, duration: ${tracks[tracks.length - 1].t.toFixed(0)}ms`);
            const preCertifyId = await getCertifyId(client);
            log(verbose, `Pre-drag CertifyId: ${preCertifyId}`);
            log(verbose, 'Dragging slider...');
            const dragStartedAt = Date.now();
            const dragResult = await dragSlider(client, tracks, sliderCenterX, sliderCenterY, targetDisplayX, undefined, gestureTuning, undefined);
            log(verbose, `Drag result: sliderMoved=${dragResult.sliderMoved}, puzzleMoved=${dragResult.puzzleMoved}`);
            log(verbose, `  sliderLeft: ${dragResult.sliderLeftBefore} -> ${dragResult.sliderLeftAfter}`);
            log(verbose, `  puzzleLeft: ${dragResult.puzzleLeftAfter}, exists=${dragResult.sliderExists}`);
            log(verbose, `  correctionApplied=${dragResult.correctionApplied}, correctionDelta=${dragResult.correctionDelta.toFixed(1)}`);
            await saveDebugShot(`attempt-${attempt}-after-drag`, {
                attempt,
                extractDurationMs: Date.now() - imageExtractStartedAt,
                matchDurationMs: Date.now() - matchStartedAt,
                match,
                targetDisplayX,
                targetSliderTravelX,
                preCertifyId,
                interaction: {
                    sliderCenter: { x: sliderCenterX, y: sliderCenterY },
                    targetPointer: { x: sliderCenterX + targetSliderTravelX, y: sliderCenterY },
                    dragDurationMs: Date.now() - dragStartedAt,
                    trackPoints: tracks.length,
                    trackDurationMs: tracks[tracks.length - 1]?.t ?? 0,
                    gestureProfile,
                    gestureTuning,
                },
                dragResult,
                dragTelemetry: await collectDragTelemetryForDebug(),
            });
            log(verbose, 'Waiting for result...');
            const resultWaitStartedAt = Date.now();
            await sleep(3000 + Math.random() * 1000);
            const captchaResponses = await evaluate(client, `window.__verifyCaptchaResponses || []`);
            if (captchaResponses.length > 0) {
                for (const resp of captchaResponses) {
                    if (/\\.(png|jpg|jpeg|webp)(\\?|$)/i.test(resp.url))
                        continue;
                    log(verbose, `VerifyCaptcha response: status=${resp.status}, url=${resp.url}`);
                    log(verbose, `  body: ${resp.body.substring(0, 500)}`);
                }
            }
            const networkTrace = await readCaptchaNetworkTrace(client);
            if (networkTrace.requests.length > 0) {
                for (const req of networkTrace.requests.slice(-5)) {
                    const classified = classifyCaptchaEvent(req.url, req.postData);
                    log(verbose, `CDP request: ${req.method} ${req.url}`);
                    if (classified.label || classified.captchaVerifyParamInfo) {
                        const info = classified.captchaVerifyParamInfo;
                        log(verbose, `  action=${classified.label || 'n/a'}, certifyId=${classified.certifyId || info?.certifyId || 'n/a'}, dataLen=${info?.dataLength ?? 'n/a'}, deviceTokenLen=${info?.deviceTokenLength ?? 'n/a'}`);
                    }
                    log(verbose, `  postData: ${req.postData.substring(0, 500)}`);
                }
            }
            if (networkTrace.responses.length > 0) {
                for (const resp of networkTrace.responses.slice(-5)) {
                    log(verbose, `CDP response: status=${resp.status}, url=${resp.url}`);
                    log(verbose, `  body: ${resp.body.substring(0, 500)}`);
                }
            }
            const result = await checkCaptchaResult(client, preCertifyId);
            const verifyCode = resolveVerifyCode(networkTrace.responses, result.verifyCode, preCertifyId);
            const backendAccepted = isSuccessfulAttemptOutcome(verifyCode, result);
            log(verbose, `Result: success=${result.success}, text="${result.captchaText}"`);
            log(verbose, `  sliderMoved=${result.sliderMoved}, puzzleMoved=${result.puzzleMoved}`);
            log(verbose, `  certifyIdChanged=${result.certifyIdChanged}, hasFailure=${result.hasFailureMessage}, hasSuccessClass=${result.hasSuccessClass}`);
            log(verbose, `  timedOut=${result.timedOut}, failureReason=${result.failureReason}`);
            log(verbose, `  hookSuccess=${result.hookSuccess}, verifyResponseSuccess=${result.verifyResponseSuccess}`);
            log(verbose, `  verifyCode=${verifyCode || 'n/a'}, backendAccepted=${backendAccepted}`);
            log(verbose, `  currentCertifyId=${result.currentCertifyId}`);
            log(verbose, `Full state: "${result.fullState.substring(0, 200)}"`);
            await saveDebugShot(`attempt-${attempt}-after-result`, {
                attempt,
                match,
                targetDisplayX,
                targetSliderTravelX,
                preCertifyId,
                dragResult,
                dragTelemetry: await collectDragTelemetryForDebug(),
                resultWaitDurationMs: Date.now() - resultWaitStartedAt,
                result,
            });
            const captured = await readCapturedParam(client);
            log(verbose, `Hook captured: param=${captured.param ? 'yes (' + captured.param.length + ' chars)' : 'no'}, success=${captured.success}`);
            if (captured.log.length > 0) {
                const compactLog = captured.log.slice(-20).map(l => `${l.event}@${l.ts}`);
                log(verbose, `Hook event log (last ${compactLog.length}):`, compactLog.join(', '));
            }
            const param = captured.param || result.captchaVerifyParam;
            if (param && backendAccepted) {
                log(verbose, 'Captcha verify param: captured and backend accepted');
                await saveDebugShot(`attempt-${attempt}-success`, {
                    match,
                    targetDisplayX,
                    targetSliderTravelX,
                    preCertifyId,
                    dragResult,
                    result,
                    captured,
                    verifyCode,
                    backendAccepted,
                });
                return {
                    success: true,
                    attempts: attempt,
                    targetX: match.x,
                    confidence: match.confidence,
                    captchaVerifyParam: param,
                    matchResult: match,
                    debugDir: debugScreenshots ? debugDir : null,
                };
            }
            if (backendAccepted) {
                lastError = 'Captcha passed visually, but captcha_verify_param was not captured';
                log(verbose, lastError);
            }
            else if (verifyCode) {
                lastError = `Backend rejected captcha with VerifyCode ${verifyCode}`;
            }
            else if (result.timedOut) {
                lastError = 'Captcha timed out. The widget expired and must be closed and retried manually.';
            }
            else if (result.hasFailureMessage) {
                lastError = 'Captcha reported failure';
            }
            else if (result.certifyIdChanged) {
                lastError = 'Captcha was reset after drag';
            }
            else {
                lastError = 'Captcha did not produce a usable verification result';
            }
            if (preCertifyId) {
                usedCertifyIds.add(preCertifyId);
                preparedCertifyIds.delete(preCertifyId);
            }
            await saveDebugShot(`attempt-${attempt}-failed-stop`, {
                attempt,
                attemptDurationMs: Date.now() - attemptStartedAt,
                match,
                targetDisplayX,
                targetSliderTravelX,
                preCertifyId,
                dragResult,
                dragTelemetry: await collectDragTelemetryForDebug(),
                result,
                captured,
                verifyCode,
                backendAccepted,
                lastError,
            });
            log(verbose, 'Attempt failed, waiting before retry...');
            await sleep(1500 + Math.random() * 1500);
            if (attempt < maxRetries) {
                const refreshed = await refreshCaptchaChallenge(client, verbose, 'between-retries', waitForPuzzleTimeout).catch(() => false);
                if (refreshed) {
                    const preparedCertifyId = await getCertifyId(client).catch(() => '');
                    if (preparedCertifyId)
                        preparedCertifyIds.add(preparedCertifyId);
                    await sleep(1000);
                }
            }
        }
        return {
            success: false,
            attempts: attemptsRun,
            targetX: 0,
            confidence: 0,
            captchaVerifyParam: null,
            matchResult: {
                x: 0,
                targetLeftX: 0,
                confidence: 0,
                scores: [],
                method: 'none',
                edgeX: -1,
                gapX: -1,
                nccX: -1,
                contourX: -1,
                pieceBounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
            },
            debugDir: debugScreenshots ? debugDir : null,
            error: lastError || `Failed after ${maxRetries} attempts`,
        };
    }
    catch (err) {
        try {
            await saveDebugShot('fatal-error', {
                error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
            });
        }
        catch { }
        throw err;
    }
    finally {
        try {
            await client.close();
        }
        catch { }
    }
}
//# sourceMappingURL=solver.js.map