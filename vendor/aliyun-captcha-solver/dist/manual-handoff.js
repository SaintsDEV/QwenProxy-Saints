#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureElementScreenshot, captureScreenshot, checkCaptchaResult, clickTrigger, connectCDP, evaluate, extractPuzzleImages, getCertifyId, installCaptchaHook, readCapturedParam, readCaptchaNetworkTrace, sleep, waitForSelector, } from './cdp.js';
import { resolveVerifyCode } from './captcha-flow.js';
import { templateMatch } from './vision.js';
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
    return {
        host: String(flags.host || '127.0.0.1'),
        port: parseInt(String(flags.port || '9222'), 10),
        targetUrl: String(flags['target-url'] || '/auth?response_type=code'),
        waitMs: parseInt(String(flags['wait-ms'] || '120000'), 10),
        rootDir: path.resolve(process.cwd(), String(flags['root-dir'] || path.join('manual-handoffs', runId))),
        verbose: !flags.quiet,
        reload: !flags['no-reload'],
    };
}
function log(verbose, ...args) {
    if (verbose)
        console.log('[manual-handoff]', ...args);
}
async function writeJson(filePath, value) {
    await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function parsePxValue(value) {
    if (!value)
        return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
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
    return {
        requestCount: requests.length,
        responseCount: responses.length,
        requestActions: requests.map((entry) => ({
            ts: entry?.ts ?? null,
            source: entry?.source ?? null,
            url: entry?.url ?? null,
            action: entry?.form?.Action || entry?.form?.action || entry?.jsonSummary?.code || null,
            certifyId: entry?.form?.CertifyId || entry?.form?.certifyId || entry?.captchaVerifyParamInfo?.certifyId || null,
        })),
        responseActions: responses.map((entry) => ({
            ts: entry?.ts ?? null,
            source: entry?.source ?? null,
            url: entry?.url ?? null,
            code: entry?.jsonSummary?.code || entry?.form?.VerifyCode || entry?.form?.Code || null,
            message: entry?.jsonSummary?.message || null,
            success: entry?.jsonSummary?.success ?? null,
            certifyId: entry?.jsonSummary?.certifyId || null,
        })),
    };
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
    const hasEmailButton = Array.from(document.querySelectorAll('button, div[role="button"], a')).some((el) =>
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
    log(verbose, 'Opening email form');
    const openedViaDomClick = await evaluate(client, `(() => {
    const textOf = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const target = buttons.find((el) => /continue with email/i.test(textOf(el)));
    if (!target) return false;
    target.click?.();
    return true;
  })()`);
    if (!openedViaDomClick) {
        const buttonRect = await evaluate(client, `(() => {
      const textOf = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"], span, p, div'));
      const target = nodes.find((el) => /continue with email/i.test(textOf(el)));
      if (!target) return null;
      const clickable = target.closest('button, a, div[role="button"]') || target;
      const rect = clickable.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`);
        if (buttonRect) {
            await clickRect(client, buttonRect);
        }
    }
    await sleep(1500);
}
async function waitForCaptchaTrigger(client, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const hasTrigger = await evaluate(client, `!!(
      document.querySelector('#aliyunCaptcha-captcha-left') ||
      document.querySelector('#aliyunCaptcha-captcha-text-box') ||
      document.querySelector('#aliyunCaptcha-captcha-body')
    )`);
        if (hasTrigger)
            return;
        await sleep(250);
    }
    throw new Error('Captcha trigger not found');
}
async function ensureCaptchaOpen(client, verbose) {
    await openEmailFormIfNeeded(client, verbose);
    const alreadyOpen = await evaluate(client, `!!(
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
    if (!alreadyOpen) {
        await waitForCaptchaTrigger(client, 15000);
        await clickTrigger(client);
    }
    await waitForSelector(client, '#aliyunCaptcha-img', 15000);
    await waitForSelector(client, '#aliyunCaptcha-puzzle', 15000);
    await waitForSelector(client, '#aliyunCaptcha-sliding-slider', 15000);
}
async function collectContext(client) {
    const page = await evaluate(client, `(() => {
    const inspect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return { selector, present: false, rect: null, text: '' };
      const rect = el.getBoundingClientRect();
      return {
        selector,
        present: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      };
    };
    return {
      url: location.href,
      title: document.title,
      bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
      elements: {
        trigger: inspect('#aliyunCaptcha-captcha-left, #aliyunCaptcha-captcha-text-box, #aliyunCaptcha-captcha-body'),
        window: inspect('#aliyunCaptcha-window-float'),
        imageBox: inspect('#aliyunCaptcha-img-box'),
        slider: inspect('#aliyunCaptcha-sliding-slider'),
      },
      verifyResponses: (window.__verifyCaptchaResponses || []).slice(-12),
      verifyRequests: (window.__verifyCaptchaRequests || []).slice(-12),
      releaseSnapshot: window.__captchaReleaseSnapshot || null,
      releaseSnapshots: (window.__captchaReleaseSnapshots || []).slice(-12),
    };
  })()`);
    const captured = await readCapturedParam(client);
    const network = await readCaptchaNetworkTrace(client);
    return { page, captured, network };
}
async function saveState(client, dir, name, extra) {
    const [png, windowPng, imgBoxPng, context] = await Promise.all([
        captureScreenshot(client),
        captureElementScreenshot(client, '#aliyunCaptcha-window-float').catch(() => null),
        captureElementScreenshot(client, '#aliyunCaptcha-img-box').catch(() => null),
        collectContext(client),
    ]);
    await writeFile(path.join(dir, `${name}.png`), png);
    if (windowPng)
        await writeFile(path.join(dir, `${name}.window.png`), windowPng);
    if (imgBoxPng)
        await writeFile(path.join(dir, `${name}.img-box.png`), imgBoxPng);
    await writeJson(path.join(dir, `${name}.json`), {
        capturedAt: new Date().toISOString(),
        context,
        extra,
    });
}
async function captureReleaseArtifacts(client, rootDir, certifyId, targetDisplayX, trigger) {
    const capturedAt = new Date().toISOString();
    const context = await collectContext(client);
    const releaseTimeline = readReleaseTimeline(context.page);
    const releaseExactPuzzleLeft = parsePxValue(String(releaseTimeline.exact?.puzzleLeft || ''));
    const releaseSettledPuzzleLeft = parsePxValue(String(releaseTimeline.latest?.puzzleLeft || ''));
    const releasePositionErrorPx = releaseExactPuzzleLeft == null
        ? null
        : Number((releaseExactPuzzleLeft - targetDisplayX).toFixed(3));
    const releaseSettledPositionErrorPx = releaseSettledPuzzleLeft == null
        ? null
        : Number((releaseSettledPuzzleLeft - targetDisplayX).toFixed(3));
    const png = await captureScreenshot(client);
    const windowPng = await captureElementScreenshot(client, '#aliyunCaptcha-window-float').catch(() => null);
    const imgBoxPng = await captureElementScreenshot(client, '#aliyunCaptcha-img-box').catch(() => null);
    await writeFile(path.join(rootDir, 'release-state.png'), png);
    if (windowPng)
        await writeFile(path.join(rootDir, 'release-state.window.png'), windowPng);
    if (imgBoxPng)
        await writeFile(path.join(rootDir, 'release-state.img-box.png'), imgBoxPng);
    await writeJson(path.join(rootDir, 'release-timeline.json'), {
        capturedAt,
        trigger,
        exact: releaseTimeline.exact || null,
        latest: releaseTimeline.latest || null,
        timeline: releaseTimeline.timeline,
    });
    await writeJson(path.join(rootDir, 'release-state.json'), {
        capturedAt,
        certifyId,
        targetDisplayX,
        releasePositionErrorPx,
        releaseSettledPositionErrorPx,
        context,
        captchaFlow: extractCaptchaFlowSummary(context.page),
        verifyCode: resolveVerifyCode(context.network.responses, null, certifyId),
        exactReleaseSnapshot: releaseTimeline.exact || null,
        settledReleaseSnapshot: releaseTimeline.latest || null,
        releaseTimeline: releaseTimeline.timeline,
        trigger,
    });
    return {
        capturedAt,
        context,
        releaseTimeline,
        releasePositionErrorPx,
        releaseSettledPositionErrorPx,
    };
}
async function main() {
    const flags = parseFlags();
    await mkdir(flags.rootDir, { recursive: true });
    console.log('=== Aliyun Manual Handoff ===');
    console.log(`CDP: ${flags.host}:${flags.port}`);
    console.log(`Target: ${flags.targetUrl}`);
    console.log(`Wait: ${flags.waitMs}ms`);
    console.log(`Output: ${flags.rootDir}`);
    console.log('');
    const client = await connectCDP(flags.host, flags.port, flags.targetUrl);
    try {
        await installCaptchaHook(client);
        if (flags.reload) {
            log(flags.verbose, 'Reloading page before handoff');
            await client.Page.reload({ ignoreCache: true });
            await sleep(2500);
        }
        await saveState(client, flags.rootDir, 'entry-state', { stage: 'before-open' });
        await ensureCaptchaOpen(client, flags.verbose);
        const certifyId = await getCertifyId(client);
        const images = await extractPuzzleImages(client);
        const bgBuffer = Buffer.from(images.backgroundBase64, 'base64');
        const pzBuffer = Buffer.from(images.puzzleBase64, 'base64');
        await writeFile(path.join(flags.rootDir, 'background.png'), bgBuffer);
        await writeFile(path.join(flags.rootDir, 'piece.png'), pzBuffer);
        const match = await templateMatch(bgBuffer, pzBuffer);
        const scaleX = images.imgBoxRect.width / images.bgNaturalWidth;
        await saveState(client, flags.rootDir, 'handoff-open', { stage: 'captcha-open', certifyId });
        await writeJson(path.join(flags.rootDir, 'analysis.json'), {
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
            certifyId,
        });
        log(flags.verbose, 'Waiting for manual result');
        const startedAt = Date.now();
        let outcome = 'pending';
        let finalResult = null;
        let releaseArtifact = null;
        let observedReleaseCount = 0;
        while (Date.now() - startedAt < flags.waitMs) {
            const context = await collectContext(client);
            const releaseTimeline = readReleaseTimeline(context.page);
            if (releaseTimeline.timeline.length > observedReleaseCount) {
                observedReleaseCount = releaseTimeline.timeline.length;
            }
            if (!releaseArtifact && observedReleaseCount > 0) {
                log(flags.verbose, `Observed human release (${observedReleaseCount} snapshots), capturing immediate release-state`);
                releaseArtifact = await captureReleaseArtifacts(client, flags.rootDir, certifyId, Math.max(0, Math.round(match.targetLeftX * scaleX)), {
                    reason: 'first_release_observed',
                    observedReleaseCount,
                    elapsedMs: Date.now() - startedAt,
                });
            }
            const result = await checkCaptchaResult(client, certifyId);
            const captured = context.captured;
            const network = context.network;
            const verifyCode = resolveVerifyCode(network.responses, result.verifyCode, certifyId);
            if (captured.param || result.success || verifyCode === 'T001') {
                outcome = 'success';
                finalResult = { result, captured, verifyCode };
                break;
            }
            if (result.hasFailureMessage || verifyCode === 'F001' || verifyCode === 'F015') {
                outcome = 'failed';
                finalResult = { result, captured, verifyCode };
                break;
            }
            await sleep(500);
        }
        const targetDisplayX = Math.max(0, Math.round(match.targetLeftX * scaleX));
        if (!releaseArtifact) {
            releaseArtifact = await captureReleaseArtifacts(client, flags.rootDir, certifyId, targetDisplayX, {
                reason: 'finalize_after_wait',
                observedReleaseCount,
                elapsedMs: Date.now() - startedAt,
            });
        }
        await saveState(client, flags.rootDir, 'handoff-result', {
            stage: 'after-wait',
            outcome,
            elapsedMs: Date.now() - startedAt,
            finalResult,
            observedReleaseCount,
        });
        await saveState(client, flags.rootDir, 'post-wait-state', {
            stage: 'post-wait',
            outcome,
            elapsedMs: Date.now() - startedAt,
            finalResult,
            observedReleaseCount,
        });
        await writeJson(path.join(flags.rootDir, 'summary.json'), {
            finishedAt: new Date().toISOString(),
            options: flags,
            certifyId,
            outcome,
            elapsedMs: Date.now() - startedAt,
            observedReleaseCount,
            success: outcome === 'success',
            verifyCode: finalResult?.verifyCode ||
                resolveVerifyCode(releaseArtifact.context.network.responses, null, certifyId),
            confidence: match.confidence,
            targetX: match.x,
            targetDisplayX,
            releasePositionErrorPx: releaseArtifact.releasePositionErrorPx,
            releaseSettledPositionErrorPx: releaseArtifact.releaseSettledPositionErrorPx,
            captchaVerifyParamCaptured: !!finalResult?.captured?.param,
            gestureProfile: 'manual_handoff',
            match,
            scaleX,
            captchaFlow: extractCaptchaFlowSummary(releaseArtifact.context.page),
            release: {
                verifyCode: resolveVerifyCode(releaseArtifact.context.network.responses, null, certifyId),
                exactSnapshot: releaseArtifact.releaseTimeline.exact || null,
                settledSnapshot: releaseArtifact.releaseTimeline.latest || null,
                timelinePhases: releaseArtifact.releaseTimeline.timeline.map((entry) => entry.phase || 'unknown'),
                capturedAt: releaseArtifact.capturedAt,
            },
            finalResult,
        });
        console.log(`Outcome: ${outcome}`);
        if (finalResult?.verifyCode) {
            console.log(`VerifyCode: ${finalResult.verifyCode}`);
        }
    }
    finally {
        try {
            await client.close();
        }
        catch { }
    }
}
await main();
//# sourceMappingURL=manual-handoff.js.map