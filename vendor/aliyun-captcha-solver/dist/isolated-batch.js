#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureElementScreenshot, captureScreenshot, checkCaptchaResult, clickTrigger, connectCDP, evaluate, extractPuzzleImages, getCertifyId, installCaptchaHook, readCaptchaNetworkTrace, readCapturedParam, resetCaptchaObservation, sleep, dragSlider, } from './cdp.js';
import { classifyCaptchaEvent, isSuccessfulAttemptOutcome, resolveVerifyCode, } from './captcha-flow.js';
import { estimateSliderTravelX } from './slider-travel.js';
import { templateMatch } from './vision.js';
import { generateHumanTrack, resolveGestureProfile, resolveGestureTuning } from './trajectory.js';
function parseFlags() {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('--'))
            continue;
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
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const rootDir = path.resolve(process.cwd(), String(flags['root-dir'] || path.join('isolated-runs', runId)));
    const mode = String(flags.mode || 'bot').toLowerCase() === 'human' ? 'human' : 'bot';
    const preReleaseCaptureFlag = String(flags['pre-release-capture'] || '').toLowerCase();
    const preReleaseCapture = preReleaseCaptureFlag === 'full' || preReleaseCaptureFlag === 'none'
        ? preReleaseCaptureFlag
        : mode === 'human'
            ? 'full'
            : 'none';
    const parseBooleanFlag = (value, defaultValue) => {
        if (typeof value === 'boolean')
            return value;
        if (value == null)
            return defaultValue;
        const normalized = String(value).trim().toLowerCase();
        if (!normalized)
            return defaultValue;
        if (['1', 'true', 'yes', 'on'].includes(normalized))
            return true;
        if (['0', 'false', 'no', 'off'].includes(normalized))
            return false;
        return defaultValue;
    };
    const captureFullDragTrace = parseBooleanFlag(flags['capture-full-drag-trace'], false) ||
        parseBooleanFlag(process.env.SOLVER_CAPTURE_DRAG_EVENT_TRACE, false) ||
        mode === 'human';
    const defaultGestureProfile = mode === 'bot' ? 'direct_fast' : 'settle_back';
    const gestureProfileInput = String(flags['gesture-profile'] ||
        process.env.SOLVER_GESTURE_PROFILE ||
        defaultGestureProfile);
    return {
        host: String(flags.host || '127.0.0.1'),
        port: parseInt(String(flags.port || '9222'), 10),
        targetUrl: String(flags['target-url'] || '/auth?response_type=code'),
        attempts: parseInt(String(flags.attempts || '10'), 10),
        postWaitMs: parseInt(String(flags['post-wait-ms'] || '11000'), 10),
        rootDir,
        verbose: !flags.quiet,
        mode,
        humanDragStartTimeoutMs: parseInt(String(flags['human-drag-start-timeout-ms'] || '30000'), 10),
        humanDragReleaseTimeoutMs: parseInt(String(flags['human-drag-release-timeout-ms'] || '20000'), 10),
        gestureProfile: resolveGestureProfile(gestureProfileInput),
        gestureProfileCycle: String(flags['gesture-profile-cycle'] || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => resolveGestureProfile(value)),
        captureFullDragTrace,
        preReleaseCapture,
        abortOnDirtyEnvironment: !!flags['abort-on-dirty-environment'],
    };
}
function log(verbose, ...args) {
    if (verbose)
        console.log('[isolated-batch]', ...args);
}
const RECENT_CERTIFY_ID_LIMIT = 30;
const recentCertifyIds = [];
function rememberCertifyId(certifyId) {
    const value = String(certifyId || '').trim();
    if (!value)
        return;
    const existingIndex = recentCertifyIds.indexOf(value);
    if (existingIndex >= 0) {
        recentCertifyIds.splice(existingIndex, 1);
    }
    recentCertifyIds.push(value);
    if (recentCertifyIds.length > RECENT_CERTIFY_ID_LIMIT) {
        recentCertifyIds.splice(0, recentCertifyIds.length - RECENT_CERTIFY_ID_LIMIT);
    }
}
async function readCurrentCertifyId(client) {
    try {
        const value = await getCertifyId(client);
        const text = String(value || '').trim();
        return text || null;
    }
    catch {
        return null;
    }
}
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}
function attemptDirName(attempt) {
    return `attempt-${String(attempt).padStart(2, '0')}`;
}
function pickGestureProfile(flags, attempt) {
    if (flags.gestureProfileCycle.length === 0) {
        return flags.gestureProfile;
    }
    return flags.gestureProfileCycle[(attempt - 1) % flags.gestureProfileCycle.length];
}
async function clickRect(client, rect) {
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, pointerType: 'mouse' });
    await sleep(70 + Math.random() * 50);
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(40 + Math.random() * 50);
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
async function writeJson(filePath, value) {
    await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}
async function collectDebugContext(client) {
    const page = await evaluate(client, `(() => {
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
        text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
    };

    return {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
      elements: {
        trigger: inspect('#aliyunCaptcha-captcha-left, #aliyunCaptcha-captcha-text-box, #aliyunCaptcha-captcha-body'),
        window: inspect('#aliyunCaptcha-window-float'),
        imageBox: inspect('#aliyunCaptcha-img-box'),
        background: inspect('#aliyunCaptcha-img'),
        puzzle: inspect('#aliyunCaptcha-puzzle'),
        slider: inspect('#aliyunCaptcha-sliding-slider'),
        refresh: inspect('#aliyunCaptcha-refresh, [class*="refresh"]'),
        passedBanner: inspect('.text-green-600, .text-green-500, [class*="success"]'),
      },
      verifyResponses: (window.__verifyCaptchaResponses || []).slice(-12),
      verifyRequests: (window.__verifyCaptchaRequests || []).slice(-12),
      dragEvents: (window.__captchaDragEvents || []).slice(-1000),
      releaseSnapshot: window.__captchaReleaseSnapshot || null,
      releaseSnapshots: (window.__captchaReleaseSnapshots || []).slice(-12),
      liveStyles: {
        sliderLeft: document.getElementById('aliyunCaptcha-sliding-slider')?.style.left || '',
        puzzleLeft: document.getElementById('aliyunCaptcha-puzzle')?.style.left || '',
        statusText: String(document.getElementById('aliyunCaptcha-sliding-text')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      },
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
            logTail: captured.log.slice(-20),
        },
        network,
    };
}
function summarizeTracks(tracks) {
    if (tracks.length === 0) {
        return {
            points: 0,
            durationMs: 0,
            xRange: 0,
            yRange: 0,
            maxStepPx: 0,
            pausesOver40ms: 0,
        };
    }
    let maxStepPx = 0;
    let pausesOver40ms = 0;
    let minY = tracks[0].y;
    let maxY = tracks[0].y;
    for (let i = 1; i < tracks.length; i++) {
        const dx = tracks[i].x - tracks[i - 1].x;
        const dt = tracks[i].t - tracks[i - 1].t;
        maxStepPx = Math.max(maxStepPx, Math.abs(dx));
        if (dt >= 40)
            pausesOver40ms++;
        minY = Math.min(minY, tracks[i].y);
        maxY = Math.max(maxY, tracks[i].y);
    }
    return {
        points: tracks.length,
        durationMs: tracks[tracks.length - 1].t,
        xRange: tracks[tracks.length - 1].x - tracks[0].x,
        yRange: Number((maxY - minY).toFixed(3)),
        maxStepPx: Number(maxStepPx.toFixed(3)),
        pausesOver40ms,
    };
}
function summarizeDragEvents(events) {
    const relevant = extractLatestDragCycle(events);
    if (relevant.length === 0) {
        return {
            sampledEvents: 0,
            totalEvents: 0,
            moveEvents: 0,
            downEvents: 0,
            upEvents: 0,
            durationMs: 0,
            startToReleaseMs: 0,
            totalDx: 0,
            totalDy: 0,
            maxStepPx: 0,
            negativeDxCount: 0,
            maxBacktrackPx: 0,
            pausesOver40ms: 0,
        };
    }
    const downEvents = relevant.filter((event) => /down$/i.test(event.type));
    const upEvents = relevant.filter((event) => /up$/i.test(event.type));
    const moveEvents = relevant.filter((event) => /move$/i.test(event.type));
    const firstTs = relevant[0].ts;
    const lastTs = relevant[relevant.length - 1].ts;
    const firstDownTs = downEvents[0]?.ts ?? firstTs;
    const lastUpTs = upEvents[upEvents.length - 1]?.ts ?? lastTs;
    let totalDx = 0;
    let totalDy = 0;
    let maxStepPx = 0;
    let negativeDxCount = 0;
    let maxBacktrackPx = 0;
    let pausesOver40ms = 0;
    for (let i = 1; i < moveEvents.length; i++) {
        const dx = moveEvents[i].x - moveEvents[i - 1].x;
        const dy = moveEvents[i].y - moveEvents[i - 1].y;
        const dt = moveEvents[i].ts - moveEvents[i - 1].ts;
        totalDx += dx;
        totalDy += dy;
        maxStepPx = Math.max(maxStepPx, Math.hypot(dx, dy));
        if (dx < 0) {
            negativeDxCount++;
            maxBacktrackPx = Math.max(maxBacktrackPx, Math.abs(dx));
        }
        if (dt >= 40)
            pausesOver40ms++;
    }
    return {
        sampledEvents: relevant.length,
        totalEvents: events.length,
        moveEvents: moveEvents.length,
        downEvents: downEvents.length,
        upEvents: upEvents.length,
        durationMs: lastTs - firstTs,
        startToReleaseMs: lastUpTs - firstDownTs,
        totalDx,
        totalDy,
        maxStepPx: Number(maxStepPx.toFixed(3)),
        negativeDxCount,
        maxBacktrackPx,
        pausesOver40ms,
    };
}
function extractLatestDragCycle(events) {
    const lastUpIndex = [...events].reverse().findIndex((event) => /up$/i.test(event.type));
    const normalizedLastUpIndex = lastUpIndex === -1 ? -1 : events.length - 1 - lastUpIndex;
    const lastDownIndex = normalizedLastUpIndex === -1
        ? events
            .map((event, index) => ({ event, index }))
            .reverse()
            .find(({ event }) => /down$/i.test(event.type))?.index ?? -1
        : events
            .slice(0, normalizedLastUpIndex + 1)
            .map((event, index) => ({ event, index }))
            .reverse()
            .find(({ event }) => /down$/i.test(event.type))?.index ?? -1;
    return lastDownIndex >= 0
        ? events.slice(lastDownIndex, normalizedLastUpIndex >= lastDownIndex ? normalizedLastUpIndex + 1 : undefined)
        : events;
}
function summarizeDragCycleDiagnostics(events) {
    const cycle = extractLatestDragCycle(events);
    const typeCounts = {};
    const targetCounts = {};
    const pathCounts = {};
    const compactEvent = (event) => ({
        type: event.type,
        ts: event.ts,
        x: event.x,
        y: event.y,
        button: event.button,
        buttons: event.buttons,
        target: event.target || '',
        path: Array.isArray(event.path) ? event.path.slice(0, 4) : [],
        isTrusted: event.isTrusted,
    });
    for (const event of cycle) {
        typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;
        const targetKey = String(event.target || '');
        targetCounts[targetKey] = (targetCounts[targetKey] || 0) + 1;
        const pathKey = Array.isArray(event.path) ? event.path.slice(0, 2).join(' > ') : '';
        pathCounts[pathKey] = (pathCounts[pathKey] || 0) + 1;
    }
    const sortEntries = (counts) => Object.entries(counts)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 6)
        .map(([key, count]) => ({ key, count }));
    return {
        cycleEventCount: cycle.length,
        typeCounts,
        topTargets: sortEntries(targetCounts),
        topPaths: sortEntries(pathCounts),
        head: cycle.slice(0, 6).map(compactEvent),
        tail: cycle.slice(-6).map(compactEvent),
    };
}
function summarizeDispatchVsDom(dispatchTrace, events) {
    const domCycle = extractLatestDragCycle(events);
    const domMouseEvents = domCycle.filter((event) => (event.type === 'mousemove' ||
        event.type === 'mousedown' ||
        event.type === 'mouseup'));
    const dispatchMouseEvents = dispatchTrace.map((event) => ({
        kind: event.cdpType === 'mouseMoved'
            ? 'mousemove'
            : event.cdpType === 'mousePressed'
                ? 'mousedown'
                : 'mouseup',
        phase: event.phase,
        tsBefore: event.tsBefore,
        tsAfter: event.tsAfter,
        x: event.x,
        y: event.y,
        plannedTrackT: event.plannedTrackT,
    }));
    const lagPairs = [];
    let maxLagMs = 0;
    let avgLagMs = 0;
    let domCursor = 0;
    for (let i = 0; i < dispatchMouseEvents.length; i++) {
        let matchIndex = -1;
        for (let j = domCursor; j < domMouseEvents.length; j++) {
            if (domMouseEvents[j].type === dispatchMouseEvents[i].kind) {
                matchIndex = j;
                break;
            }
        }
        if (matchIndex === -1) {
            continue;
        }
        const matchedDom = domMouseEvents[matchIndex];
        domCursor = matchIndex + 1;
        const lagMs = matchedDom.ts - dispatchMouseEvents[i].tsAfter;
        lagPairs.push({
            index: lagPairs.length,
            kind: dispatchMouseEvents[i].kind,
            phase: dispatchMouseEvents[i].phase,
            dispatchTs: dispatchMouseEvents[i].tsAfter,
            domTs: matchedDom.ts,
            lagMs,
            dispatchX: dispatchMouseEvents[i].x,
            domX: matchedDom.x,
            plannedTrackT: dispatchMouseEvents[i].plannedTrackT ?? null,
        });
        maxLagMs = Math.max(maxLagMs, lagMs);
        avgLagMs += lagMs;
    }
    const pairCount = lagPairs.length;
    return {
        dispatchCount: dispatchMouseEvents.length,
        domCount: domMouseEvents.length,
        pairCount,
        unmatchedDispatchCount: Math.max(0, dispatchMouseEvents.length - pairCount),
        unmatchedDomCount: Math.max(0, domMouseEvents.length - pairCount),
        avgLagMs: pairCount ? Number((avgLagMs / pairCount).toFixed(3)) : null,
        maxLagMs: pairCount ? maxLagMs : null,
        firstDispatchTs: dispatchMouseEvents[0]?.tsAfter ?? null,
        lastDispatchTs: dispatchMouseEvents[dispatchMouseEvents.length - 1]?.tsAfter ?? null,
        firstDomTs: domMouseEvents[0]?.ts ?? null,
        lastDomTs: domMouseEvents[domMouseEvents.length - 1]?.ts ?? null,
        dispatchSpanMs: dispatchMouseEvents.length >= 2
            ? dispatchMouseEvents[dispatchMouseEvents.length - 1].tsAfter - dispatchMouseEvents[0].tsAfter
            : 0,
        domSpanMs: domMouseEvents.length >= 2
            ? domMouseEvents[domMouseEvents.length - 1].ts - domMouseEvents[0].ts
            : 0,
        headPairs: lagPairs.slice(0, 8),
        tailPairs: lagPairs.slice(-8),
    };
}
function parsePxValue(value) {
    if (!value)
        return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function createEmptyDispatchSummary() {
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
function summarizeHumanTrajectory(events) {
    const ordered = [...events].sort((a, b) => a.ts - b.ts);
    const start = ordered[0] || null;
    const end = ordered[ordered.length - 1] || null;
    let distancePx = 0;
    for (let i = 1; i < ordered.length; i++) {
        const dx = ordered[i].x - ordered[i - 1].x;
        const dy = ordered[i].y - ordered[i - 1].y;
        distancePx += Math.sqrt(dx * dx + dy * dy);
    }
    const moveEvents = ordered.filter((event) => event.phase === 'drag_move');
    const lastMove = moveEvents[moveEvents.length - 1] || null;
    const fineTail = moveEvents.slice(-8);
    let microCorrectionCount = 0;
    for (let i = 2; i < fineTail.length; i++) {
        const prevDx = fineTail[i - 1].x - fineTail[i - 2].x;
        const nextDx = fineTail[i].x - fineTail[i - 1].x;
        if (Math.abs(prevDx) >= 1 && Math.abs(nextDx) >= 1 && Math.sign(prevDx) !== Math.sign(nextDx)) {
            microCorrectionCount++;
        }
    }
    return {
        pointCount: ordered.length,
        dragStartTs: start?.ts ?? null,
        dragEndTs: end?.ts ?? null,
        dragDurationMs: start && end
            ? Math.max(0, end.ts - start.ts)
            : 0,
        totalDistancePx: Number(distancePx.toFixed(3)),
        moveEventCount: moveEvents.length,
        microCorrectionCount,
        timeLastMoveToReleaseMs: lastMove && end
            ? Math.max(0, end.ts - lastMove.ts)
            : null,
    };
}
function readReleaseTimeline(page) {
    const timeline = Array.isArray(page.releaseSnapshots)
        ? page.releaseSnapshots.filter((entry) => !!entry && typeof entry === 'object')
        : [];
    const latest = page.releaseSnapshot && typeof page.releaseSnapshot === 'object'
        ? page.releaseSnapshot
        : null;
    return {
        timeline,
        exact: timeline.find((entry) => entry.phase === 'event') || timeline[0] || latest,
        latest: timeline[timeline.length - 1] || latest,
    };
}
function extractCaptchaFlowSummary(context) {
    const requests = Array.isArray(context.verifyRequests) ? context.verifyRequests : [];
    const responses = Array.isArray(context.verifyResponses) ? context.verifyResponses : [];
    const requestActions = requests.map((entry) => {
        const classified = classifyCaptchaEvent(entry?.url, entry?.body);
        return {
            ts: entry?.ts ?? null,
            source: entry?.source ?? null,
            url: entry?.url ?? null,
            action: classified.label,
            certifyId: classified.certifyId || entry?.captchaVerifyParamInfo?.certifyId || null,
            hasCaptchaVerifyParam: !!entry?.captchaVerifyParamInfo,
            captchaVerifyParamInfo: classified.captchaVerifyParamInfo || entry?.captchaVerifyParamInfo || null,
        };
    });
    const responseActions = responses.map((entry) => {
        const classified = classifyCaptchaEvent(entry?.url, entry?.body);
        return {
            ts: entry?.ts ?? null,
            source: entry?.source ?? null,
            url: entry?.url ?? null,
            code: classified.verifyCode,
            action: classified.label,
            success: classified.success ?? entry?.jsonSummary?.success ?? null,
            certifyId: classified.certifyId || entry?.jsonSummary?.certifyId || null,
        };
    });
    const timeline = [
        ...requests.map((entry) => {
            const classified = classifyCaptchaEvent(entry?.url, entry?.body);
            return {
                ts: entry?.ts ?? null,
                direction: 'request',
                source: entry?.source ?? null,
                url: entry?.url ?? null,
                label: classified.label,
                certifyId: classified.certifyId || entry?.captchaVerifyParamInfo?.certifyId || null,
                verifyCode: null,
                success: null,
                hasCaptchaVerifyParam: !!entry?.captchaVerifyParamInfo,
                captchaVerifyParamInfo: classified.captchaVerifyParamInfo || entry?.captchaVerifyParamInfo || null,
            };
        }),
        ...responses.map((entry) => {
            const classified = classifyCaptchaEvent(entry?.url, entry?.body);
            return {
                ts: entry?.ts ?? null,
                direction: 'response',
                source: entry?.source ?? null,
                url: entry?.url ?? null,
                label: classified.label,
                certifyId: classified.certifyId || entry?.jsonSummary?.certifyId || null,
                verifyCode: classified.verifyCode,
                success: classified.success ?? entry?.jsonSummary?.success ?? null,
                status: entry?.status ?? null,
            };
        }),
    ]
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .slice(-24);
    return {
        requestCount: requests.length,
        responseCount: responses.length,
        requestActions,
        responseActions,
        timeline,
    };
}
function findLatestVerifyRequest(requests) {
    let fallback = null;
    for (let i = requests.length - 1; i >= 0; i--) {
        const entry = requests[i];
        const rawBody = entry?.body || entry?.postData || null;
        const classified = classifyCaptchaEvent(entry?.url, rawBody);
        const captchaVerifyParamInfo = entry?.captchaVerifyParamInfo || classified.captchaVerifyParamInfo;
        if (captchaVerifyParamInfo) {
            return {
                ts: typeof entry?.ts === 'number' ? entry.ts : null,
                url: entry?.url || null,
                captchaVerifyParamInfo,
            };
        }
        if (!fallback && classified.label === 'VerifyCaptchaV3') {
            fallback = {
                ts: typeof entry?.ts === 'number' ? entry.ts : null,
                url: entry?.url || null,
                captchaVerifyParamInfo: null,
            };
        }
    }
    return fallback;
}
function summarizeBatchAttempts(attempts) {
    const codeCounts = {};
    const errorsByCode = {};
    let successCount = 0;
    let failureCount = 0;
    let abortedCount = 0;
    for (const attempt of attempts) {
        if (attempt.success)
            successCount++;
        else if (attempt.outcome === 'aborted')
            abortedCount++;
        else
            failureCount++;
        const code = attempt.verifyCode || 'n/a';
        codeCounts[code] = (codeCounts[code] || 0) + 1;
        if (typeof attempt.releasePositionErrorPx === 'number' && Number.isFinite(attempt.releasePositionErrorPx)) {
            (errorsByCode[code] ||= []).push(attempt.releasePositionErrorPx);
        }
    }
    const releaseErrorByCode = Object.fromEntries(Object.entries(errorsByCode).map(([code, values]) => {
        const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
        const absAvg = values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length;
        return [code, {
                samples: values.length,
                avgPx: Number(avg.toFixed(3)),
                avgAbsPx: Number(absAvg.toFixed(3)),
                minPx: Number(Math.min(...values).toFixed(3)),
                maxPx: Number(Math.max(...values).toFixed(3)),
            }];
    }));
    return {
        totalAttempts: attempts.length,
        successCount,
        failureCount,
        abortedCount,
        successRate: attempts.length ? Number((successCount / attempts.length).toFixed(4)) : 0,
        verifyCodeCounts: codeCounts,
        releaseErrorByCode,
        successfulAttempts: attempts
            .filter((attempt) => attempt.success)
            .map((attempt) => ({
            attempt: attempt.attempt,
            verifyCode: attempt.verifyCode,
            releasePositionErrorPx: attempt.releasePositionErrorPx ?? null,
            targetDisplayX: attempt.targetDisplayX,
        })),
    };
}
async function captureAttemptState(client) {
    const context = await collectDebugContext(client);
    const windowPng = await captureElementScreenshot(client, '#aliyunCaptcha-window-float').catch(() => null);
    const imgBoxPng = await captureElementScreenshot(client, '#aliyunCaptcha-img-box').catch(() => null);
    const png = await captureScreenshot(client);
    return {
        png,
        windowPng,
        imgBoxPng,
        context,
        capturedAt: new Date().toISOString(),
    };
}
function classifyEnvironmentState(state) {
    const flags = [];
    const viewport = state.page.viewport;
    const captcha = state.page.captcha;
    const windowRect = captcha.windowRect;
    if (viewport.width >= 1500)
        flags.push('wide_viewport');
    if (viewport.height >= 900)
        flags.push('tall_viewport');
    if (viewport.devicePixelRatio !== 1)
        flags.push('non_1x_device_pixel_ratio');
    if (viewport.visualViewportScale !== null && Math.abs(viewport.visualViewportScale - 1) > 0.01) {
        flags.push('visual_viewport_scaled');
    }
    if (!state.page.focus.hasFocus)
        flags.push('page_not_focused');
    if (state.page.focus.hidden)
        flags.push('page_hidden');
    if (state.page.navigator.webdriver === true)
        flags.push('navigator_webdriver_true');
    if (state.page.translateTextInDom)
        flags.push('translate_text_in_page_dom');
    if (captcha.zoomRatio && captcha.zoomRatio !== '1')
        flags.push('captcha_zoom_ratio_non_1');
    const browserBounds = state.browserWindow?.bounds || null;
    const browserWidth = Number(browserBounds?.width || 0);
    const browserHeight = Number(browserBounds?.height || 0);
    if (browserWidth >= 1500)
        flags.push('wide_browser_window');
    if (browserHeight >= 900)
        flags.push('tall_browser_window');
    if (browserWidth > 0 && browserWidth - viewport.width > 600)
        flags.push('viewport_browser_width_mismatch');
    if (browserHeight > 0 && browserHeight - viewport.height > 400)
        flags.push('viewport_browser_height_mismatch');
    if (state.page.windowOuter.width - viewport.width > 600)
        flags.push('viewport_outer_width_mismatch');
    if (state.page.windowOuter.height - viewport.height > 400)
        flags.push('viewport_outer_height_mismatch');
    if (state.page.focus.hasFocus && state.page.focus.hidden)
        flags.push('focused_but_hidden_page');
    if (windowRect) {
        const rightGap = viewport.width - (windowRect.x + windowRect.width);
        const bottomGap = viewport.height - (windowRect.y + windowRect.height);
        if (windowRect.x < 24)
            flags.push('captcha_near_left_edge');
        if (windowRect.y < 24)
            flags.push('captcha_near_top_edge');
        if (rightGap < 24)
            flags.push('captcha_near_right_edge');
        if (bottomGap < 24)
            flags.push('captcha_near_bottom_edge');
    }
    return flags;
}
function fatalEnvironmentFlags(flags) {
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
async function collectEnvironmentState(client) {
    const page = await evaluate(client, `(() => {
    const rectOf = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const visible = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const captchaWindow = document.getElementById('aliyunCaptcha-window-float');
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        visualViewportWidth: window.visualViewport ? window.visualViewport.width : null,
        visualViewportHeight: window.visualViewport ? window.visualViewport.height : null,
        visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      windowOuter: {
        width: window.outerWidth,
        height: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
      },
      focus: {
        hasFocus: document.hasFocus(),
        hidden: document.hidden,
        visibilityState: document.visibilityState,
      },
      navigator: {
        webdriver: typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null,
        language: navigator.language || '',
        languages: Array.from(navigator.languages || []),
        platform: navigator.platform || '',
        userAgent: navigator.userAgent || '',
      },
      captcha: {
        windowRect: rectOf('#aliyunCaptcha-window-float'),
        imageBoxRect: rectOf('#aliyunCaptcha-img-box'),
        sliderRect: rectOf('#aliyunCaptcha-sliding-slider'),
        windowVisible: visible('#aliyunCaptcha-window-float'),
        zoomRatio: (
          captchaWindow
            ? getComputedStyle(captchaWindow).getPropertyValue('--aliyun-zoom-ratio')
            : rootStyle.getPropertyValue('--aliyun-zoom-ratio')
        ).trim() || '1',
        text: String(captchaWindow?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      },
      translateTextInDom: /google translate|traduzir|ingl[eê]s|portugu[eê]s/i.test(text),
    };
  })()`);
    let browserWindow = null;
    try {
        if (client.Browser?.getWindowForTarget) {
            browserWindow = await client.Browser.getWindowForTarget();
        }
    }
    catch (error) {
        browserWindow = {
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const baseState = {
        capturedAt: new Date().toISOString(),
        page,
        browserWindow,
    };
    return {
        ...baseState,
        flags: classifyEnvironmentState(baseState),
    };
}
async function saveEnvironmentState(client, attemptDir, name, extra) {
    const state = await collectEnvironmentState(client);
    await writeJson(path.join(attemptDir, `${name}.json`), {
        ...state,
        attemptDir,
        extra,
    });
    return state;
}
async function readHumanDragState(client) {
    return evaluate(client, `(() => {
    const state = window.__captchaHumanDrag || {};
    return {
      cycle: Number(state.cycle || 0),
      armed: !!state.armed,
      started: !!state.started,
      active: !!state.active,
      released: !!state.released,
      startTs: typeof state.startTs === 'number' ? state.startTs : null,
      endTs: typeof state.endTs === 'number' ? state.endTs : null,
      startType: state.startType || null,
      endType: state.endType || null,
      startEvent: state.startEvent || null,
      releaseEvent: state.releaseEvent || null,
      events: Array.isArray(state.events) ? state.events.slice(-800) : [],
    };
  })()`);
}
async function readHumanMotionSample(client) {
    return evaluate(client, `(() => {
    const slider = document.getElementById('aliyunCaptcha-sliding-slider');
    const puzzle = document.getElementById('aliyunCaptcha-puzzle');
    const win = document.getElementById('aliyunCaptcha-window-float');
    const passed = document.querySelector('.text-green-600, .text-green-500, [class*="success"]');
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const parse = (value) => {
      const num = parseFloat(value || '');
      return Number.isFinite(num) ? num : null;
    };
    return {
      ts: Date.now(),
      sliderLeft: parse(slider?.style.left || ''),
      puzzleLeft: parse(puzzle?.style.left || ''),
      windowVisible: visible(win),
      passedVisible: visible(passed),
    };
  })()`);
}
function releaseMotionToLivePosition(sample) {
    if (typeof sample?.sliderLeft === 'number' &&
        typeof sample.puzzleLeft === 'number') {
        return {
            sliderLeft: sample.sliderLeft,
            puzzleLeft: sample.puzzleLeft,
        };
    }
    return null;
}
async function waitForHumanDragAndCapture(client, flags, attempt) {
    console.log(`Attempt ${attempt}/${flags.attempts} ready`);
    console.log('Drag manually now');
    console.log('Waiting for drag start...');
    const startDeadline = Date.now() + flags.humanDragStartTimeoutMs;
    let humanState = await readHumanDragState(client);
    while (!humanState.started && Date.now() < startDeadline) {
        await sleep(75);
        humanState = await readHumanDragState(client);
    }
    if (!humanState.started) {
        throw new Error('aborted_timeout_before_drag');
    }
    console.log('Human drag detected');
    let preReleaseSnapshot = null;
    const humanMotionSamples = [];
    let samplerStopped = false;
    const sampler = (async () => {
        while (!samplerStopped) {
            const state = await readHumanDragState(client);
            const motion = await readHumanMotionSample(client);
            humanMotionSamples.push(motion);
            if (humanMotionSamples.length > 800) {
                humanMotionSamples.splice(0, humanMotionSamples.length - 800);
            }
            if (state.released)
                break;
            if (state.active && (motion.sliderLeft ?? 0) > 0) {
                try {
                    preReleaseSnapshot = await captureAttemptState(client);
                }
                catch { }
            }
            await sleep(35);
        }
    })();
    const releaseDeadline = Date.now() + flags.humanDragReleaseTimeoutMs;
    while (!humanState.released && Date.now() < releaseDeadline) {
        await sleep(50);
        humanState = await readHumanDragState(client);
    }
    samplerStopped = true;
    await sampler.catch(() => { });
    if (!humanState.released) {
        throw new Error('aborted_timeout_after_drag_start');
    }
    console.log('Release detected, capturing artifacts...');
    let releaseSnapshot = null;
    const releaseProbeDeadline = Date.now() + 1200;
    while (Date.now() < releaseProbeDeadline) {
        const motion = await readHumanMotionSample(client);
        humanMotionSamples.push(motion);
        if (humanMotionSamples.length > 800) {
            humanMotionSamples.splice(0, humanMotionSamples.length - 800);
        }
        if ((motion.puzzleLeft ?? 0) > 0 || (motion.sliderLeft ?? 0) > 0 || motion.passedVisible || !motion.windowVisible) {
            releaseSnapshot = await captureAttemptState(client);
            break;
        }
        await sleep(50);
    }
    if (!releaseSnapshot) {
        releaseSnapshot = await captureAttemptState(client);
    }
    humanState = await readHumanDragState(client);
    const humanTrajectorySummary = summarizeHumanTrajectory(humanState.events || []);
    const liveStyles = releaseSnapshot.context.page.liveStyles;
    const lastHumanMotionWithPuzzle = humanMotionSamples.slice().reverse().find((sample) => typeof sample.puzzleLeft === 'number' && sample.puzzleLeft > 0) || null;
    const lastHumanMotionWithSlider = humanMotionSamples.slice().reverse().find((sample) => typeof sample.sliderLeft === 'number' && sample.sliderLeft > 0) || null;
    const dragResult = {
        sliderMoved: parsePxValue(liveStyles.sliderLeft) != null && (parsePxValue(liveStyles.sliderLeft) || 0) > 2,
        puzzleMoved: parsePxValue(liveStyles.puzzleLeft) != null && (parsePxValue(liveStyles.puzzleLeft) || 0) > 2,
        sliderLeftBefore: '0px',
        sliderLeftAfter: liveStyles.sliderLeft || '',
        puzzleLeftAfter: liveStyles.puzzleLeft || '',
        sliderExists: true,
        mousedownFired: !!humanState.started,
        trackPoints: humanState.events.length,
        method: 'human',
        correctionApplied: humanTrajectorySummary.microCorrectionCount > 0,
        correctionDelta: 0,
        correctionMoves: humanTrajectorySummary.microCorrectionCount,
        fineTuneMoves: humanTrajectorySummary.microCorrectionCount,
        gestureDurationMs: humanTrajectorySummary.dragDurationMs,
        preReleaseLivePosition: releaseMotionToLivePosition(lastHumanMotionWithPuzzle || lastHumanMotionWithSlider),
        releasePointer: humanState.releaseEvent
            ? { x: humanState.releaseEvent.x, y: humanState.releaseEvent.y }
            : null,
        lastMoveToReleaseMs: humanTrajectorySummary.timeLastMoveToReleaseMs,
        previousMovePhaseBeforeRelease: null,
        releaseTimingBreakdown: null,
        finalPhaseDispatchDegraded: false,
        dispatchTrace: [],
        dispatchSummary: createEmptyDispatchSummary(),
    };
    return {
        dragResult,
        preReleaseSnapshot,
        releaseSnapshot,
        humanDragState: humanState,
        humanTrajectorySummary,
        humanMotionSamples,
    };
}
async function waitForAttemptOutcome(client, preCertifyId, timeoutMs) {
    const startedAt = Date.now();
    let lastSnapshot = null;
    while (Date.now() - startedAt < timeoutMs) {
        const [result, captured, network] = await Promise.all([
            checkCaptchaResult(client, preCertifyId),
            readCapturedParam(client),
            readCaptchaNetworkTrace(client),
        ]);
        const verifyCode = resolveVerifyCode(network.responses, result.verifyCode, preCertifyId);
        const decisive = !!verifyCode ||
            result.hasFailureMessage ||
            result.timedOut ||
            result.certifyIdChanged ||
            result.verifyResponseSuccess;
        lastSnapshot = {
            result,
            captured,
            network,
            verifyCode,
            observedAfterMs: Date.now() - startedAt,
            decisive,
        };
        if (decisive) {
            return lastSnapshot;
        }
        await sleep(100);
    }
    if (lastSnapshot) {
        return lastSnapshot;
    }
    const [result, captured, network] = await Promise.all([
        checkCaptchaResult(client, preCertifyId),
        readCapturedParam(client),
        readCaptchaNetworkTrace(client),
    ]);
    return {
        result,
        captured,
        network,
        verifyCode: resolveVerifyCode(network.responses, result.verifyCode, preCertifyId),
        observedAfterMs: timeoutMs,
        decisive: false,
    };
}
async function saveAttemptState(client, attemptDir, name, extra) {
    const state = await captureAttemptState(client);
    await writeFile(path.join(attemptDir, `${name}.png`), state.png);
    if (state.windowPng) {
        await writeFile(path.join(attemptDir, `${name}.window.png`), state.windowPng);
    }
    if (state.imgBoxPng) {
        await writeFile(path.join(attemptDir, `${name}.img-box.png`), state.imgBoxPng);
    }
    await writeJson(path.join(attemptDir, `${name}.json`), {
        capturedAt: state.capturedAt,
        attemptDir,
        context: state.context,
        extra,
    });
}
async function readCaptchaVisualOutcome(client) {
    return evaluate(client, `(() => {
    const win = document.getElementById('aliyunCaptcha-window-float');
    const slidingText = document.getElementById('aliyunCaptcha-sliding-text')?.textContent || '';
    const windowText = win?.textContent || '';
    const bodyText = document.body?.innerText || '';
    const text = String([slidingText, windowText, bodyText].join(' ')).replace(/\\s+/g, ' ').trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const lower = text.toLowerCase();
    const success = /slide successful|verification passed|verified successfully|successfully/i.test(text);
    const failed = /verification failed|please try again|try again/i.test(text);
    const banner = Array.from(document.querySelectorAll('#aliyunCaptcha-window-float *')).find((el) => {
      const value = String(el.textContent || '').toLowerCase();
      return /slide successful|verification passed|verification failed|please try again/.test(value);
    });
    return {
      kind: success ? 'success' : failed ? 'failed' : null,
      text: text.slice(0, 500),
      windowVisible: visible(win),
      bannerVisible: visible(banner),
    };
  })()`);
}
async function waitForCaptchaVisualOutcome(client, timeoutMs) {
    const startedAt = Date.now();
    let latest = { kind: null, text: '', windowVisible: false, bannerVisible: false };
    while (Date.now() - startedAt < timeoutMs) {
        latest = await readCaptchaVisualOutcome(client);
        if (latest.kind)
            return latest;
        await sleep(60);
    }
    return latest;
}
async function saveOutcomeCaptchaState(client, attemptDir, visualOutcome, extra) {
    if (visualOutcome.kind && !visualOutcome.bannerVisible) {
        await waitForCaptchaVisualOutcome(client, 500);
    }
    await sleep(120);
    const [context, windowPng, imgBoxPng] = await Promise.all([
        collectDebugContext(client),
        captureElementScreenshot(client, '#aliyunCaptcha-window-float').catch(() => null),
        captureElementScreenshot(client, '#aliyunCaptcha-img-box').catch(() => null),
    ]);
    const fullPagePng = await captureScreenshot(client).catch(() => null);
    if (windowPng) {
        await writeFile(path.join(attemptDir, 'outcome-captcha.window.png'), windowPng);
    }
    if (imgBoxPng) {
        await writeFile(path.join(attemptDir, 'outcome-captcha.img-box.png'), imgBoxPng);
    }
    if (fullPagePng) {
        await writeFile(path.join(attemptDir, 'outcome-captcha.png'), fullPagePng);
    }
    await writeJson(path.join(attemptDir, 'outcome-captcha.json'), {
        capturedAt: new Date().toISOString(),
        attemptDir,
        visualOutcome,
        context,
        extra,
    });
}
async function closeExistingCaptcha(client, verbose) {
    const staleCaptcha = await evaluate(client, `(() => {
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
    if (staleCaptcha.windowVisible && staleCaptcha.hasClose) {
        const reason = staleCaptcha.timedOut
            ? 'timed-out'
            : staleCaptcha.sliderVisible
                ? 'open'
                : 'incomplete';
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
            log(verbose, 'Existing captcha did not close before fresh attempt');
        }
        await sleep(300);
    }
}
async function resolveReloadUrl(client, targetUrl) {
    const currentHref = await evaluate(client, `location.href`).catch(() => '');
    const requested = String(targetUrl || '').trim();
    if (/^https?:\/\//i.test(requested)) {
        return requested;
    }
    if (/^https?:\/\//i.test(currentHref)) {
        try {
            return requested ? new URL(requested, currentHref).href : currentHref;
        }
        catch {
            return currentHref;
        }
    }
    return requested
        ? new URL(requested, 'https://chat.z.ai').href
        : 'https://chat.z.ai/auth?response_type=code';
}
async function reloadPage(client, verbose, targetUrl) {
    const reloadUrl = await resolveReloadUrl(client, targetUrl);
    log(verbose, `Reloading page for next attempt: ${reloadUrl}`);
    await client.Page.navigate({ url: 'about:blank' });
    await sleep(400);
    await client.Page.navigate({ url: reloadUrl });
    await sleep(2500);
}
async function readAuthSurfaceState(client) {
    return evaluate(client, `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const hasTrigger = !!(
      document.querySelector('#aliyunCaptcha-captcha-left') ||
      document.querySelector('#aliyunCaptcha-captcha-text-box') ||
      document.querySelector('#aliyunCaptcha-captcha-body')
    );
    const hasVisibleFormInput = Array.from(document.querySelectorAll('input')).some((el) => {
      const placeholder = String(el.getAttribute('placeholder') || '');
      return isVisible(el) && (
        /full name/i.test(placeholder) ||
        /email/i.test(placeholder) ||
        el.getAttribute('type') === 'password'
      );
    });
    const hasEmailButton = Array.from(document.querySelectorAll('button, div[role="button"]')).some((el) =>
      /continue with email/i.test((el.textContent || '').trim())
    );
    const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      hasTrigger,
      hasEmailButton,
      hasVisibleFormInput,
      onChooserScreen: /continue with email/i.test(bodyText),
      bodyText,
    };
  })()`);
}
async function openEmailFormIfNeeded(client, verbose) {
    const state = await readAuthSurfaceState(client);
    if (state.hasTrigger || (state.hasVisibleFormInput && !state.onChooserScreen) || (!state.hasEmailButton && !state.onChooserScreen)) {
        return;
    }
    log(verbose, 'Opening email form after reload');
    const waitForInputs = () => evaluate(client, `new Promise((resolve) => {
    const start = Date.now();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const tick = () => {
      const ready = Array.from(document.querySelectorAll('input')).some((el) => {
        const placeholder = String(el.getAttribute('placeholder') || '');
        return isVisible(el) && (
          /full name/i.test(placeholder) ||
          /email/i.test(placeholder) ||
          el.getAttribute('type') === 'password'
        );
      });
      if (ready) return resolve(true);
      if (Date.now() - start > 4000) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  })`);
    const waitForChooserExit = () => evaluate(client, `new Promise((resolve) => {
    const start = Date.now();
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const tick = () => {
      const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      const stillChooser = /continue with email/i.test(bodyText);
      const hasVisibleInput = Array.from(document.querySelectorAll('input')).some((el) => {
        const placeholder = String(el.getAttribute('placeholder') || '');
        return isVisible(el) && (
          /full name/i.test(placeholder) ||
          /email/i.test(placeholder) ||
          el.getAttribute('type') === 'password'
        );
      });
      const hasTrigger = !!(
        document.querySelector('#aliyunCaptcha-captcha-left') ||
        document.querySelector('#aliyunCaptcha-captcha-text-box') ||
        document.querySelector('#aliyunCaptcha-captcha-body')
      );
      if (!stillChooser || hasVisibleInput || hasTrigger) return resolve(true);
      if (Date.now() - start > 4000) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  })`);
    const openedViaDomClick = await evaluate(client, `(() => {
    const textOf = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const target = buttons.find((el) => /continue with email/i.test(textOf(el)));
    if (!target) return false;
    target.click?.();
    return true;
  })()`);
    if (openedViaDomClick) {
        await sleep(1200);
        const chooserExited = await waitForChooserExit();
        const ready = await waitForInputs();
        if (chooserExited || ready)
            return;
    }
    const buttonRect = await evaluate(client, `(() => {
    const textOf = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const preferred = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const fallback = Array.from(document.querySelectorAll('span, p, div'));
    const target = preferred.find((el) => /continue with email/i.test(textOf(el)))
      || fallback.find((el) => /continue with email/i.test(textOf(el)));
    if (!target) return null;
    const clickable = target.closest('button, a, div[role="button"]') || target;
    const rect = clickable.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
    if (buttonRect) {
        await clickRect(client, buttonRect);
    }
    await sleep(1500);
    const chooserExited = await waitForChooserExit();
    const ready = await waitForInputs();
    if (!chooserExited && !ready) {
        const finalState = await readAuthSurfaceState(client);
        log(verbose, 'Email form did not open cleanly', finalState);
    }
}
async function waitForCaptchaTrigger(client, timeoutMs) {
    const start = Date.now();
    let lastRecoveryAttempt = 0;
    while (Date.now() - start < timeoutMs) {
        const hasTrigger = await evaluate(client, `!!(
      document.querySelector('#aliyunCaptcha-captcha-left') ||
      document.querySelector('#aliyunCaptcha-captcha-text-box') ||
      document.querySelector('#aliyunCaptcha-captcha-body')
    )`);
        if (hasTrigger)
            return;
        if (Date.now() - lastRecoveryAttempt >= 1200) {
            lastRecoveryAttempt = Date.now();
            const state = await readAuthSurfaceState(client);
            if (state.onChooserScreen || state.hasEmailButton) {
                await openEmailFormIfNeeded(client, false);
            }
        }
        await sleep(250);
    }
    throw new Error('Captcha trigger not found after reload/wait');
}
async function waitForVisiblePuzzle(client, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await evaluate(client, `(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        );
      };
      const win = document.getElementById('aliyunCaptcha-window-float');
      const imgBox = document.getElementById('aliyunCaptcha-img-box');
      const bg = document.getElementById('aliyunCaptcha-img');
      const puzzle = document.getElementById('aliyunCaptcha-puzzle');
      const slider = document.getElementById('aliyunCaptcha-sliding-slider');
      const text = [
        document.getElementById('aliyunCaptcha-sliding-text')?.textContent || '',
        win?.textContent || '',
      ].join(' ');
      const timedOut = /timed out|close and retry/i.test(text);
      const winVisible = visible(win) && !String(win?.className || '').includes('hidden');
      const bgReady = visible(bg) && (!('complete' in bg) || bg.complete !== false) && Number(bg.naturalWidth || 0) > 0;
      const puzzleReady = visible(puzzle) && (!('complete' in puzzle) || puzzle.complete !== false) && Number(puzzle.naturalWidth || 0) > 0;
      return (
        winVisible &&
        visible(imgBox) &&
        bgReady &&
        puzzleReady &&
        visible(slider) &&
        !timedOut
      );
    })()`);
        if (ready)
            return true;
        await sleep(150);
    }
    return false;
}
async function ensureCaptchaReady(client, verbose, waitForPuzzleTimeout) {
    await openEmailFormIfNeeded(client, verbose);
    if (await waitForVisiblePuzzle(client, 600)) {
        log(verbose, 'Captcha already open');
        return;
    }
    for (let openAttempt = 1; openAttempt <= 3; openAttempt++) {
        await waitForCaptchaTrigger(client, waitForPuzzleTimeout);
        log(verbose, `Clicking captcha trigger (${openAttempt}/3)`);
        await clickTrigger(client);
        if (await waitForVisiblePuzzle(client, waitForPuzzleTimeout)) {
            return;
        }
        log(verbose, 'Puzzle did not become fully visible, closing and retrying trigger');
        await closeExistingCaptcha(client, verbose);
        await sleep(500);
    }
    throw new Error('Captcha puzzle did not become fully visible with a usable slider');
}
async function runAttempt(client, flags, attempt) {
    const attemptDir = path.join(flags.rootDir, attemptDirName(attempt));
    await mkdir(attemptDir, { recursive: true });
    log(flags.verbose, `Starting attempt ${attempt}/${flags.attempts}`);
    const blockedCertifyIds = new Set(recentCertifyIds);
    const currentCertifyId = await readCurrentCertifyId(client);
    if (currentCertifyId)
        blockedCertifyIds.add(currentCertifyId);
    let entryEnvironment = null;
    let puzzleEnvironment = null;
    let preCertifyId = null;
    let images = null;
    let freshCaptchaAttempt = 0;
    for (freshCaptchaAttempt = 1; freshCaptchaAttempt <= 3; freshCaptchaAttempt++) {
        if (freshCaptchaAttempt > 1) {
            await reloadPage(client, flags.verbose, flags.targetUrl);
        }
        await closeExistingCaptcha(client, flags.verbose);
        await resetCaptchaObservation(client);
        entryEnvironment = await saveEnvironmentState(client, attemptDir, 'entry-environment', {
            attempt,
            stage: 'before-puzzle-open',
            freshCaptchaAttempt,
            blockedCertifyIds: Array.from(blockedCertifyIds),
        });
        await saveAttemptState(client, attemptDir, 'entry-state', {
            attempt,
            stage: 'before-puzzle-open',
            freshCaptchaAttempt,
            blockedCertifyIds: Array.from(blockedCertifyIds),
        });
        await ensureCaptchaReady(client, flags.verbose, 15000);
        preCertifyId = await readCurrentCertifyId(client);
        puzzleEnvironment = await saveEnvironmentState(client, attemptDir, 'environment-state', {
            attempt,
            stage: 'puzzle-open',
            freshCaptchaAttempt,
            preCertifyId,
        });
        if (!preCertifyId) {
            log(flags.verbose, `Attempt ${attempt}: captcha opened without CertifyId, retrying fresh challenge`);
            await saveAttemptState(client, attemptDir, `no-certify-id-${freshCaptchaAttempt}`, {
                attempt,
                stage: 'freshness-retry',
                freshCaptchaAttempt,
            });
            continue;
        }
        if (blockedCertifyIds.has(preCertifyId)) {
            log(flags.verbose, `Attempt ${attempt}: reused CertifyId ${preCertifyId}, retrying fresh challenge`);
            rememberCertifyId(preCertifyId);
            await saveAttemptState(client, attemptDir, `stale-certify-id-${freshCaptchaAttempt}`, {
                attempt,
                stage: 'freshness-retry',
                freshCaptchaAttempt,
                reusedCertifyId: preCertifyId,
            });
            blockedCertifyIds.add(preCertifyId);
            continue;
        }
        images = await extractPuzzleImages(client);
        const geometryUsable = Number.isFinite(images.imgBoxRect.width) &&
            Number.isFinite(images.imgBoxRect.height) &&
            Number.isFinite(images.sliderRect.width) &&
            Number.isFinite(images.sliderRect.height) &&
            images.imgBoxRect.width > 0 &&
            images.imgBoxRect.height > 0 &&
            images.sliderRect.width > 0 &&
            images.sliderRect.height > 0 &&
            images.bgNaturalWidth > 0;
        if (geometryUsable) {
            break;
        }
        log(flags.verbose, `Attempt ${attempt}: captcha geometry unusable after open, retrying fresh challenge`);
        await saveAttemptState(client, attemptDir, `unusable-geometry-${freshCaptchaAttempt}`, {
            attempt,
            stage: 'freshness-retry',
            freshCaptchaAttempt,
            preCertifyId,
            images,
        });
        rememberCertifyId(preCertifyId);
        blockedCertifyIds.add(preCertifyId);
        images = null;
    }
    if (!entryEnvironment || !puzzleEnvironment || !preCertifyId || !images || blockedCertifyIds.has(preCertifyId)) {
        throw new Error(`Could not open a fresh usable captcha after ${freshCaptchaAttempt - 1} attempt(s); ` +
            `lastCertifyId=${preCertifyId || 'n/a'} blocked=${Array.from(blockedCertifyIds).join(',') || 'none'}`);
    }
    if (puzzleEnvironment.flags.length > 0) {
        log(flags.verbose, `Attempt ${attempt}: environment flags: ${puzzleEnvironment.flags.join(', ')}`);
    }
    const fatalEnvFlags = fatalEnvironmentFlags(puzzleEnvironment.flags);
    if (flags.abortOnDirtyEnvironment && fatalEnvFlags.length > 0) {
        throw new Error(`Dirty environment before drag: ${fatalEnvFlags.join(', ')}`);
    }
    await saveAttemptState(client, attemptDir, 'puzzle-open-state', {
        attempt,
        stage: 'puzzle-open',
        freshCaptchaAttempt,
        preCertifyId,
    });
    const bgBuffer = Buffer.from(images.backgroundBase64, 'base64');
    const pzBuffer = Buffer.from(images.puzzleBase64, 'base64');
    await writeFile(path.join(attemptDir, 'background.png'), bgBuffer);
    await writeFile(path.join(attemptDir, 'piece.png'), pzBuffer);
    const match = await templateMatch(bgBuffer, pzBuffer);
    const scaleX = images.imgBoxRect.width / images.bgNaturalWidth;
    const targetOffset = envNumber('SOLVER_TARGET_OFFSET', 0);
    const targetBias = envNumber('SOLVER_TARGET_BIAS', 1);
    const gestureProfile = pickGestureProfile(flags, attempt);
    const gestureTuning = resolveGestureTuning(gestureProfile);
    const targetDisplayX = Math.max(0, Math.round(match.targetLeftX * scaleX + targetOffset + targetBias));
    const targetSliderTravelX = estimateSliderTravelX(targetDisplayX, gestureProfile, flags.mode);
    const tracks = generateHumanTrack(targetSliderTravelX, gestureProfile);
    const sliderCenterX = images.sliderRect.x + images.sliderRect.width / 2;
    const sliderCenterY = images.sliderRect.y + images.sliderRect.height / 2;
    await writeJson(path.join(attemptDir, 'analysis.json'), {
        attempt,
        images: {
            bgNaturalWidth: images.bgNaturalWidth,
            bgNaturalHeight: images.bgNaturalHeight,
            pzNaturalWidth: images.pzNaturalWidth,
            pzNaturalHeight: images.pzNaturalHeight,
            imgBoxRect: images.imgBoxRect,
            sliderRect: images.sliderRect,
        },
        match,
        scaleX,
        targetOffset,
        targetBias,
        gestureProfile,
        gestureTuning,
        freshCaptchaAttempt,
        blockedCertifyIds: Array.from(blockedCertifyIds),
        targetDisplayX,
        targetSliderTravelX,
        preCertifyId,
        sliderCenter: { x: sliderCenterX, y: sliderCenterY },
        environmentFlags: puzzleEnvironment.flags,
        tracks,
        trackSummary: summarizeTracks(tracks),
    });
    let releaseSnapshot = null;
    let preReleaseSnapshot = null;
    let humanDragState = null;
    let humanTrajectorySummary = null;
    let humanMotionSamples = null;
    let dragResult;
    if (flags.mode === 'human') {
        const humanAttempt = await waitForHumanDragAndCapture(client, flags, attempt);
        dragResult = humanAttempt.dragResult;
        preReleaseSnapshot = humanAttempt.preReleaseSnapshot;
        releaseSnapshot = humanAttempt.releaseSnapshot;
        humanDragState = humanAttempt.humanDragState;
        humanTrajectorySummary = humanAttempt.humanTrajectorySummary;
        humanMotionSamples = humanAttempt.humanMotionSamples;
        await writeJson(path.join(attemptDir, 'human-trajectory.json'), {
            attempt,
            mode: 'human',
            targetDisplayX,
            dragStartTs: humanDragState.startTs,
            dragEndTs: humanDragState.endTs,
            summary: humanTrajectorySummary,
            events: humanDragState.events,
            motionSamples: humanMotionSamples,
        });
    }
    else {
        dragResult = await dragSlider(client, tracks, sliderCenterX, sliderCenterY, targetDisplayX, async () => {
            releaseSnapshot = await captureAttemptState(client);
        }, gestureTuning, flags.preReleaseCapture === 'full'
            ? async () => {
                preReleaseSnapshot = await captureAttemptState(client);
            }
            : undefined);
    }
    const releaseCaptured = await readCapturedParam(client);
    const releaseNetwork = await readCaptchaNetworkTrace(client);
    const releaseResult = await checkCaptchaResult(client, preCertifyId);
    if (preReleaseSnapshot !== null) {
        const preReleaseState = preReleaseSnapshot;
        await writeFile(path.join(attemptDir, 'pre-release-state.png'), preReleaseState.png);
        if (preReleaseState.windowPng) {
            await writeFile(path.join(attemptDir, 'pre-release-state.window.png'), preReleaseState.windowPng);
        }
        if (preReleaseState.imgBoxPng) {
            await writeFile(path.join(attemptDir, 'pre-release-state.img-box.png'), preReleaseState.imgBoxPng);
        }
        await writeJson(path.join(attemptDir, 'pre-release-state.json'), {
            capturedAt: preReleaseState.capturedAt,
            attemptDir,
            context: preReleaseState.context,
            attempt,
            targetDisplayX,
            preCertifyId,
        });
    }
    const finalReleaseSnapshot = releaseSnapshot || await captureAttemptState(client);
    const dragEvents = finalReleaseSnapshot.context.page.dragEvents || [];
    const dispatchVsDom = summarizeDispatchVsDom(dragResult.dispatchTrace, dragEvents);
    const dragEventSummary = summarizeDragEvents(dragEvents);
    const dragCycleDiagnostics = summarizeDragCycleDiagnostics(dragEvents);
    const releaseSnapshots = readReleaseTimeline(finalReleaseSnapshot.context.page);
    const lastHumanMotionWithPuzzle = humanMotionSamples?.slice().reverse().find((sample) => typeof sample.puzzleLeft === 'number' && sample.puzzleLeft > 0) || null;
    const lastHumanMotionWithSlider = humanMotionSamples?.slice().reverse().find((sample) => typeof sample.sliderLeft === 'number' && sample.sliderLeft > 0) || null;
    const releasePuzzleLeft = flags.mode === 'human' && lastHumanMotionWithPuzzle
        ? lastHumanMotionWithPuzzle.puzzleLeft
        : parsePxValue(String(releaseSnapshots.exact?.puzzleLeft || ''));
    const releaseSettledPuzzleLeft = parsePxValue(String(releaseSnapshots.latest?.puzzleLeft || '')) ??
        (flags.mode === 'human' && lastHumanMotionWithPuzzle
            ? lastHumanMotionWithPuzzle.puzzleLeft
            : null);
    const releasePositionErrorPx = releasePuzzleLeft == null
        ? null
        : Number((releasePuzzleLeft - targetDisplayX).toFixed(3));
    const releaseSettledPositionErrorPx = releaseSettledPuzzleLeft == null
        ? null
        : Number((releaseSettledPuzzleLeft - targetDisplayX).toFixed(3));
    const releaseCaptureLagMs = typeof releaseSnapshots.exact?.ts === 'number'
        ? Math.max(0, Date.parse(finalReleaseSnapshot.capturedAt) - releaseSnapshots.exact.ts)
        : null;
    await writeFile(path.join(attemptDir, 'release-state.png'), finalReleaseSnapshot.png);
    if (finalReleaseSnapshot.windowPng) {
        await writeFile(path.join(attemptDir, 'release-state.window.png'), finalReleaseSnapshot.windowPng);
    }
    if (finalReleaseSnapshot.imgBoxPng) {
        await writeFile(path.join(attemptDir, 'release-state.img-box.png'), finalReleaseSnapshot.imgBoxPng);
    }
    await writeJson(path.join(attemptDir, 'release-timeline.json'), {
        capturedAt: finalReleaseSnapshot.capturedAt,
        captureLagMs: releaseCaptureLagMs,
        exact: releaseSnapshots.exact || null,
        latest: releaseSnapshots.latest || null,
        timeline: releaseSnapshots.timeline,
    });
    await writeJson(path.join(attemptDir, 'release-state.json'), {
        capturedAt: finalReleaseSnapshot.capturedAt,
        attemptDir,
        context: finalReleaseSnapshot.context,
        attempt,
        match,
        scaleX,
        targetOffset,
        targetBias,
        gestureProfile,
        gestureTuning,
        targetDisplayX,
        targetSliderTravelX,
        preCertifyId,
        preReleaseCapture: flags.preReleaseCapture,
        tracks,
        dragResult,
        mode: flags.mode,
        humanDragState,
        humanTrajectorySummary,
        humanMotionSamples,
        releaseMotionSample: lastHumanMotionWithPuzzle || lastHumanMotionWithSlider,
        releasePositionErrorPx,
        releaseSettledPositionErrorPx,
        releaseCaptureLagMs,
        environment: {
            entry: entryEnvironment,
            puzzleOpen: puzzleEnvironment,
        },
        trackSummary: summarizeTracks(tracks),
        dragEventSummary,
        dragCycleDiagnostics,
        dispatchVsDom,
        captchaFlow: extractCaptchaFlowSummary(finalReleaseSnapshot.context.page),
        result: releaseResult,
        captured: releaseCaptured,
        network: releaseNetwork,
        verifyCode: resolveVerifyCode(releaseNetwork.responses, releaseResult.verifyCode, preCertifyId),
        exactReleaseSnapshot: releaseSnapshots.exact || null,
        settledReleaseSnapshot: releaseSnapshots.latest || null,
        releaseTimeline: releaseSnapshots.timeline,
        capturePhase: releaseSnapshots.exact?.phase || 'release',
    });
    log(flags.verbose, `Attempt ${attempt}: release snapshot saved, waiting for first decisive outcome (timeout ${flags.postWaitMs}ms)`);
    const outcomeSnapshot = await waitForAttemptOutcome(client, preCertifyId, flags.postWaitMs);
    const result = outcomeSnapshot.result;
    const captured = outcomeSnapshot.captured;
    const network = outcomeSnapshot.network;
    const verifyCode = outcomeSnapshot.verifyCode;
    const visualOutcome = await waitForCaptchaVisualOutcome(client, 1500);
    const verifyRequest = findLatestVerifyRequest(network.requests);
    const hookCapturedEvent = captured.param ? classifyCaptchaEvent(null, captured.param) : null;
    const networkCaptchaVerifyParamInfo = verifyRequest?.captchaVerifyParamInfo || null;
    const hookCaptchaVerifyParamInfo = hookCapturedEvent?.captchaVerifyParamInfo || null;
    const captchaVerifyParamInfo = networkCaptchaVerifyParamInfo ||
        hookCaptchaVerifyParamInfo ||
        null;
    const captchaVerifyParamSource = networkCaptchaVerifyParamInfo ? 'network' : hookCaptchaVerifyParamInfo ? 'hook' : 'none';
    const releaseToVerifyMs = typeof releaseSnapshots.exact?.ts === 'number' && typeof verifyRequest?.ts === 'number'
        ? Math.max(0, verifyRequest.ts - releaseSnapshots.exact.ts)
        : null;
    if (visualOutcome.kind) {
        await saveOutcomeCaptchaState(client, attemptDir, visualOutcome, {
            attempt,
            stage: 'outcome-captcha',
            observedAfterMs: outcomeSnapshot.observedAfterMs,
            decisiveOutcomeObserved: outcomeSnapshot.decisive,
            result,
            verifyCode,
        });
    }
    await saveAttemptState(client, attemptDir, 'post-wait-state', {
        attempt,
        stage: 'post-wait',
        postWaitMs: flags.postWaitMs,
        freshCaptchaAttempt,
        observedAfterMs: outcomeSnapshot.observedAfterMs,
        decisiveOutcomeObserved: outcomeSnapshot.decisive,
        visualOutcome,
        result,
        captured,
        network,
        verifyCode,
    });
    const success = isSuccessfulAttemptOutcome(verifyCode, result);
    const outcome = success
        ? 'success'
        : result.hasFailureMessage || !!verifyCode || result.timedOut || result.certifyIdChanged
            ? 'failed'
            : 'aborted';
    const summary = {
        attempt,
        attemptDir,
        success,
        outcome,
        mode: flags.mode,
        dragMethod: flags.mode === 'human' ? 'human' : 'bot',
        preReleaseCapture: flags.preReleaseCapture,
        verifyCode,
        certifyId: preCertifyId || null,
        targetX: match.x,
        targetDisplayX,
        targetSliderTravelX,
        confidence: match.confidence,
        captchaVerifyParamCaptured: !!captured.param || !!captchaVerifyParamInfo,
        captchaVerifyParamSource,
        captchaDataLength: captchaVerifyParamInfo?.dataLength ?? null,
        deviceTokenLength: captchaVerifyParamInfo?.deviceTokenLength ?? null,
        captchaDataHash: captchaVerifyParamInfo?.dataHash ?? null,
        deviceTokenHash: captchaVerifyParamInfo?.deviceTokenHash ?? null,
        releaseToVerifyMs,
        humanDragDetected: !!humanDragState?.started,
        dragStartTs: humanDragState?.startTs ?? null,
        dragEndTs: humanDragState?.endTs ?? null,
        humanInterventionRequired: flags.mode === 'human',
        releasePositionErrorPx,
        releaseSettledPositionErrorPx,
        releaseCaptureLagMs,
        environmentFlags: puzzleEnvironment.flags,
    };
    await writeJson(path.join(attemptDir, 'summary.json'), {
        ...summary,
        postWaitMs: flags.postWaitMs,
        observedAfterMs: outcomeSnapshot.observedAfterMs,
        decisiveOutcomeObserved: outcomeSnapshot.decisive,
        visualOutcome,
        match,
        scaleX,
        targetOffset,
        targetBias,
        gestureProfile,
        gestureTuning,
        freshCaptchaAttempt,
        blockedCertifyIds: Array.from(blockedCertifyIds),
        targetSliderTravelX,
        preCertifyId,
        dragResult,
        mode: flags.mode,
        dragMethod: flags.mode === 'human' ? 'human' : 'bot',
        preReleaseCapture: flags.preReleaseCapture,
        humanDragDetected: !!humanDragState?.started,
        dragStartTs: humanDragState?.startTs ?? null,
        dragEndTs: humanDragState?.endTs ?? null,
        humanInterventionRequired: flags.mode === 'human',
        humanDragState,
        humanTrajectorySummary,
        humanMotionSamples,
        releaseMotionSample: lastHumanMotionWithPuzzle || lastHumanMotionWithSlider,
        releasePositionErrorPx,
        releaseSettledPositionErrorPx,
        releaseCaptureLagMs,
        environmentFlags: puzzleEnvironment.flags,
        environment: {
            entry: entryEnvironment,
            puzzleOpen: puzzleEnvironment,
        },
        trackSummary: summarizeTracks(tracks),
        dragEventSummary,
        dragCycleDiagnostics,
        dispatchVsDom,
        captchaFlow: extractCaptchaFlowSummary(finalReleaseSnapshot.context.page),
        release: {
            result: releaseResult,
            captured: releaseCaptured,
            verifyCode: resolveVerifyCode(releaseNetwork.responses, releaseResult.verifyCode, preCertifyId),
            exactSnapshot: releaseSnapshots.exact || null,
            settledSnapshot: releaseSnapshots.latest || null,
            timelinePhases: releaseSnapshots.timeline.map((entry) => entry.phase || 'unknown'),
        },
        postWait: {
            result,
            captured,
            network,
            verifyCode,
            observedAfterMs: outcomeSnapshot.observedAfterMs,
            decisiveOutcomeObserved: outcomeSnapshot.decisive,
        },
    });
    rememberCertifyId(preCertifyId);
    return summary;
}
async function main() {
    const flags = parseFlags();
    await mkdir(flags.rootDir, { recursive: true });
    console.log('=== Aliyun Isolated Batch Runner ===');
    console.log(`CDP: ${flags.host}:${flags.port}`);
    console.log(`Target: ${flags.targetUrl}`);
    console.log(`Attempts: ${flags.attempts}`);
    console.log(`Post-wait: ${flags.postWaitMs}ms`);
    console.log(`Mode: ${flags.mode}`);
    console.log(`Gesture profile: ${flags.gestureProfile}`);
    console.log(`Capture full drag trace: ${flags.captureFullDragTrace}`);
    console.log(`Pre-release capture: ${flags.preReleaseCapture}`);
    console.log(`Abort on dirty environment: ${flags.abortOnDirtyEnvironment}`);
    if (flags.gestureProfileCycle.length > 0) {
        console.log(`Gesture cycle: ${flags.gestureProfileCycle.join(', ')}`);
    }
    console.log(`Output: ${flags.rootDir}`);
    console.log('');
    await writeJson(path.join(flags.rootDir, 'run.json'), {
        startedAt: new Date().toISOString(),
        options: flags,
    });
    const client = await connectCDP(flags.host, flags.port, flags.targetUrl);
    const summaries = [];
    try {
        await installCaptchaHook(client, { captureFullDragTrace: flags.captureFullDragTrace });
        await reloadPage(client, flags.verbose, flags.targetUrl);
        for (let attempt = 1; attempt <= flags.attempts; attempt++) {
            try {
                const summary = await runAttempt(client, flags, attempt);
                summaries.push(summary);
                log(flags.verbose, `Attempt ${attempt} done: success=${summary.success}, verifyCode=${summary.verifyCode ?? 'n/a'}`);
            }
            catch (err) {
                const attemptDir = path.join(flags.rootDir, attemptDirName(attempt));
                await mkdir(attemptDir, { recursive: true });
                const errorText = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
                try {
                    await saveAttemptState(client, attemptDir, 'failure-state', {
                        attempt,
                        error: errorText,
                    });
                }
                catch { }
                const abortedSummary = {
                    attempt,
                    attemptDir,
                    success: false,
                    outcome: 'aborted',
                    mode: flags.mode,
                    dragMethod: flags.mode === 'human' ? 'human' : 'bot',
                    preReleaseCapture: flags.preReleaseCapture,
                    verifyCode: null,
                    certifyId: null,
                    targetX: 0,
                    targetDisplayX: 0,
                    targetSliderTravelX: 0,
                    confidence: 0,
                    captchaVerifyParamCaptured: false,
                    captchaVerifyParamSource: 'none',
                    captchaDataLength: null,
                    deviceTokenLength: null,
                    captchaDataHash: null,
                    deviceTokenHash: null,
                    releaseToVerifyMs: null,
                    humanDragDetected: false,
                    dragStartTs: null,
                    dragEndTs: null,
                    humanInterventionRequired: flags.mode === 'human',
                    releasePositionErrorPx: null,
                    releaseSettledPositionErrorPx: null,
                    releaseCaptureLagMs: null,
                    environmentFlags: [],
                    error: errorText,
                };
                await writeJson(path.join(attemptDir, 'summary.json'), abortedSummary);
                summaries.push(abortedSummary);
            }
            if (attempt < flags.attempts) {
                await reloadPage(client, flags.verbose, flags.targetUrl);
            }
        }
    }
    finally {
        try {
            await client.close();
        }
        catch { }
    }
    await writeJson(path.join(flags.rootDir, 'summary.json'), {
        finishedAt: new Date().toISOString(),
        options: flags,
        attempts: summaries,
        stats: summarizeBatchAttempts(summaries),
    });
    console.log('\n=== Batch Summary ===');
    for (const summary of summaries) {
        console.log(`Attempt ${String(summary.attempt).padStart(2, '0')}: success=${summary.success} verifyCode=${summary.verifyCode ?? 'n/a'} dir=${summary.attemptDir}`);
    }
    const stats = summarizeBatchAttempts(summaries);
    console.log(`Success rate: ${stats.successCount}/${stats.totalAttempts} (${(stats.successRate * 100).toFixed(1)}%)`);
    console.log(`Verify codes: ${Object.entries(stats.verifyCodeCounts).map(([code, count]) => `${code}=${count}`).join(', ')}`);
}
await main();
//# sourceMappingURL=isolated-batch.js.map