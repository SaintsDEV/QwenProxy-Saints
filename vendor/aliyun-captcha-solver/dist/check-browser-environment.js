#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCDP, evaluate } from './cdp.js';
function parseFlags() {
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
        host: String(flags.host || '127.0.0.1'),
        port: Number(flags.port || 9222),
        targetUrl: String(flags['target-url'] || '/auth?response_type=code'),
        outputDir: path.resolve(process.cwd(), String(flags['output-dir'] || 'analysis-browser-environment')),
    };
}
function classify(check) {
    const flags = [];
    const viewport = check.page.viewport;
    const browserBounds = check.browserWindow?.bounds || null;
    const browserWidth = Number(browserBounds?.width || 0);
    const browserHeight = Number(browserBounds?.height || 0);
    const captchaRect = check.page.captcha.windowRect;
    if (viewport.width >= 1500)
        flags.push('wide_viewport');
    if (viewport.height >= 900)
        flags.push('tall_viewport');
    if (browserWidth >= 1500)
        flags.push('wide_browser_window');
    if (browserHeight >= 900)
        flags.push('tall_browser_window');
    if (browserWidth > 0 && browserWidth - viewport.width > 600)
        flags.push('viewport_browser_width_mismatch');
    if (browserHeight > 0 && browserHeight - viewport.height > 400)
        flags.push('viewport_browser_height_mismatch');
    if (check.page.windowOuter.width - viewport.width > 600)
        flags.push('viewport_outer_width_mismatch');
    if (check.page.windowOuter.height - viewport.height > 400)
        flags.push('viewport_outer_height_mismatch');
    if (viewport.devicePixelRatio !== 1)
        flags.push('non_1x_device_pixel_ratio');
    if (viewport.visualViewportScale !== null && Math.abs(viewport.visualViewportScale - 1) > 0.01) {
        flags.push('visual_viewport_scaled');
    }
    if (!check.page.focus.hasFocus)
        flags.push('page_not_focused');
    if (check.page.focus.hidden)
        flags.push('page_hidden');
    if (check.page.focus.hasFocus && check.page.focus.hidden)
        flags.push('focused_but_hidden_page');
    if (check.page.navigator.webdriver === true)
        flags.push('navigator_webdriver_true');
    if (check.page.translateTextInDom)
        flags.push('translate_text_in_page_dom');
    if (captchaRect) {
        const rightGap = viewport.width - (captchaRect.x + captchaRect.width);
        const bottomGap = viewport.height - (captchaRect.y + captchaRect.height);
        if (captchaRect.x < 24)
            flags.push('captcha_near_left_edge');
        if (captchaRect.y < 24)
            flags.push('captcha_near_top_edge');
        if (rightGap < 24)
            flags.push('captcha_near_right_edge');
        if (bottomGap < 24)
            flags.push('captcha_near_bottom_edge');
    }
    return flags;
}
async function readEnvironment(client, cdp) {
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
    return {
      url: location.href,
      title: document.title,
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
        windowVisible: visible('#aliyunCaptcha-window-float'),
        windowRect: rectOf('#aliyunCaptcha-window-float'),
        imageBoxRect: rectOf('#aliyunCaptcha-img-box'),
        triggerRect: rectOf('#aliyunCaptcha-captcha-left, #aliyunCaptcha-captcha-text-box, #aliyunCaptcha-captcha-body'),
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
    const baseCheck = {
        capturedAt: new Date().toISOString(),
        cdp,
        page,
        browserWindow,
    };
    return {
        ...baseCheck,
        flags: classify(baseCheck),
    };
}
function rectText(rect) {
    if (!rect)
        return 'n/a';
    return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
}
function renderMarkdown(check) {
    const bounds = check.browserWindow?.bounds;
    const browserBounds = bounds
        ? `${bounds.left ?? 0},${bounds.top ?? 0},${bounds.width ?? 0}x${bounds.height ?? 0} ${bounds.windowState || ''}`.trim()
        : 'n/a';
    return [
        '# Browser Environment Check',
        '',
        `- Captured at: ${check.capturedAt}`,
        `- URL: ${check.page.url}`,
        `- Viewport: ${check.page.viewport.width}x${check.page.viewport.height}@${check.page.viewport.devicePixelRatio}`,
        `- Browser bounds: ${browserBounds}`,
        `- Page focus: hasFocus=${check.page.focus.hasFocus} hidden=${check.page.focus.hidden} visibility=${check.page.focus.visibilityState}`,
        `- Navigator: webdriver=${check.page.navigator.webdriver} language=${check.page.navigator.language} platform=${check.page.navigator.platform}`,
        `- Captcha window: visible=${check.page.captcha.windowVisible} rect=${rectText(check.page.captcha.windowRect)}`,
        `- Captcha trigger: ${rectText(check.page.captcha.triggerRect)}`,
        `- Translate text in DOM: ${check.page.translateTextInDom}`,
        `- Flags: ${check.flags.join(', ') || 'none'}`,
        '',
        'Notes:',
        '- This check does not interact with the captcha.',
        '- Chrome UI popups such as Google Translate are usually outside page DOM; absence here does not prove they are absent on screen.',
    ].join('\n');
}
async function main() {
    const flags = parseFlags();
    const cdp = {
        host: flags.host,
        port: flags.port,
        targetUrl: flags.targetUrl,
    };
    let client;
    try {
        client = await connectCDP(flags.host, flags.port, flags.targetUrl);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error([
            `Could not connect to CDP at ${flags.host}:${flags.port} for target "${flags.targetUrl}".`,
            'Start the debug browser first:',
            '  npm run browser:cdp',
            `Original error: ${message}`,
        ].join('\n'));
    }
    try {
        const check = await readEnvironment(client, cdp);
        await mkdir(flags.outputDir, { recursive: true });
        const jsonPath = path.join(flags.outputDir, 'browser-environment.json');
        const mdPath = path.join(flags.outputDir, 'browser-environment.md');
        await writeFile(jsonPath, JSON.stringify(check, null, 2), 'utf8');
        await writeFile(mdPath, renderMarkdown(check), 'utf8');
        console.log(`Saved: ${jsonPath}`);
        console.log(`Saved: ${mdPath}`);
        console.log(`Viewport: ${check.page.viewport.width}x${check.page.viewport.height}@${check.page.viewport.devicePixelRatio}`);
        console.log(`Flags: ${check.flags.join(', ') || 'none'}`);
    }
    finally {
        await client.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
//# sourceMappingURL=check-browser-environment.js.map