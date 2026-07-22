import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { addAccount, removeAccount } from "../core/accounts.ts";
import { config } from "../core/config.ts";
import {
  accountHasCapturedHeaders,
  ensureAccountHeaders,
  initPlaywrightForAccount,
} from "./playwright.ts";
import {
  createTempMailbox,
  extractVerification,
  generateAccountPassword,
  generateDisplayName,
  listUrsaMessages,
  waitForUrsaVerificationLink,
  waitForVerificationEmail,
  type TempMailbox,
} from "./temp-mail.ts";
import {
  dismissVerifiedCaptcha,
  isAccessVerificationVisible,
  isCaptchaVerified,
  openCaptchaIfNeeded,
  solveAliyunPuzzleCaptcha,
} from "./aliyun-captcha-solver.ts";
import {
  ensureCaptchaApi,
  reserveCdpPort,
  solveCaptchaViaApi,
} from "./aliyun-captcha-api.ts";

export type RegistrationState =
  | "queued"
  | "preparing-email"
  | "opening-browser"
  | "filling-form"
  | "solving-captcha"
  | "pending_activation"
  | "waiting-verification"
  | "applying-verification"
  | "capturing-session"
  | "authenticating"
  | "completed"
  | "failed";

export interface RegistrationJob {
  id: string;
  email: string;
  state: RegistrationState;
  message: string;
  createdAt: number;
  updatedAt: number;
  accountId?: string;
  ready?: boolean;
  error?: string;
  provider?: string;
  verificationCode?: string;
  hasCookies?: boolean;
}

export interface RegistrationRequest {
  email?: string;
  password?: string;
  displayName?: string;
  useTempEmail?: boolean;
}

const jobs = new Map<string, RegistrationJob>();
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlineRemaining = (deadline: number) =>
  Math.max(5_000, deadline - Date.now());

function publicJob(job: RegistrationJob): RegistrationJob {
  return { ...job };
}

function setJob(
  job: RegistrationJob,
  state: RegistrationState,
  message: string,
  error?: string,
): void {
  job.state = state;
  job.message = message;
  job.updatedAt = Date.now();
  job.error = error;
  console.log(
    `🧾 [Registration] ${job.id.slice(0, 8)} | ${state} | ${message}`,
  );
}

function pruneJobs(): void {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

export function listRegistrationJobs(): RegistrationJob[] {
  pruneJobs();
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export function getRegistrationJob(id: string): RegistrationJob | undefined {
  const job = jobs.get(id);
  return job ? publicJob(job) : undefined;
}

async function clickByText(page: Page, texts: string[]): Promise<boolean> {
  for (const text of texts) {
    const loc = page.getByText(text, { exact: false }).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 5_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function fillByName(
  page: Page,
  name: string,
  value: string,
): Promise<boolean> {
  const loc = page.locator(`input[name="${name}"]`).first();
  if (await loc.count()) {
    await loc.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    await loc.click({ timeout: 5_000 }).catch(() => {});
    await loc.fill("");
    await loc.fill(value);
    // trigger React/antd change events
    await loc.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc?.set?.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
    return true;
  }
  return false;
}

async function collectSessionSignal(page: Page): Promise<{
  cookieCount: number;
  hasAuthCookie: boolean;
  localToken: string;
  url: string;
}> {
  const cookies = await page.context().cookies();
  const hasAuthCookie = cookies.some(
    (c) =>
      /token|session|auth|acw_tc|tfstk|cna|isg|sca|ssxmod/i.test(c.name) &&
      Boolean(c.value),
  );
  const localToken = await page
    .evaluate(() => {
      try {
        return (
          localStorage.getItem("qwen_token") ||
          localStorage.getItem("access_token") ||
          localStorage.getItem("token") ||
          ""
        );
      } catch {
        return "";
      }
    })
    .catch(() => "");
  return {
    cookieCount: cookies.length,
    hasAuthCookie,
    localToken,
    url: page.url(),
  };
}

async function pageShowsActivationPending(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText().catch(() => "");
  return /pendente de ativa|pending activation|ative a sua conta|activate your account|e-mail de verifica|verification email|verifique o seu e-mail|check your email|reenviar e-mail|resend email/i.test(
    text,
  );
}

function payloadLooksPendingActivation(payload: unknown): boolean {
  const raw =
    typeof payload === "string"
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload ?? {});
          } catch {
            return String(payload ?? "");
          }
        })();
  return /pending activation|pendente de ativa|activation link|ative a sua conta|activate your account|check your email|verifique o seu e-mail/i.test(
    raw,
  );
}

/**
 * Real chat shell only — NOT cookies / qwen_token alone.
 * Pending-activation accounts often already have a token and still fail create-chat.
 * Also ignore temporary Access Verification overlays when deciding shell presence.
 */
async function pageShowsChatShell(page: Page): Promise<boolean> {
  if (await pageShowsActivationPending(page)) return false;

  const url = page.url();
  const onAuthPage = /\/auth|\/login|\/signup|\/register/i.test(url);
  if (onAuthPage) return false;

  // Portuguese / English empty-state greetings used by Qwen Studio
  const greetingVisible = await page
    .locator(
      [
        "text=/O que está na agenda hoje/i",
        "text=/O que o traz aqui hoje/i",
        "text=/Qual é o plano para hoje/i",
        "text=/How can I help/i",
        "text=/Como posso ajud/i",
        "text=/What.*(agenda|plan|bring)/i",
      ].join(", "),
    )
    .first()
    .isVisible()
    .catch(() => false);

  const composerVisible = await page
    .locator(
      [
        'textarea:visible',
        '[contenteditable="true"]:visible',
        'button:has-text("Nova Conversa")',
        'button:has-text("New chat")',
        'button:has-text("Novo chat")',
        '[placeholder*="ajud" i]',
        '[placeholder*="help" i]',
        '[placeholder*="Ask" i]',
        '[placeholder*="Pergunt" i]',
      ].join(", "),
    )
    .first()
    .isVisible()
    .catch(() => false);

  return greetingVisible || composerVisible;
}

/**
 * Probe Qwen API from the page context. Pending activation returns Bad_Request
 * even when cookies / qwen_token look valid.
 */
async function probeAccountActivationFromPage(
  page: Page,
): Promise<{ ok: boolean; detail: string }> {
  // Prefer navigating to chat home first so cookies apply on chat.qwen.ai
  if (!/chat\.qwen\.ai/i.test(page.url())) {
    await page
      .goto("https://chat.qwen.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      .catch(() => {});
    await sleep(1_200);
  }

  if (await pageShowsActivationPending(page)) {
    return { ok: false, detail: "UI ainda mostra pendente de ativação" };
  }

  const result = await page
    .evaluate(async () => {
      try {
        const response = await fetch("/api/v2/chats/new", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
          },
          body: JSON.stringify({
            title: "Nova Conversa",
            models: ["qwen-max-latest"],
            chat_mode: "normal",
            chat_type: "t2t",
            timestamp: Date.now(),
            project_id: "",
          }),
        });
        const text = await response.text();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        return {
          status: response.status,
          ok: response.ok,
          text: text.slice(0, 500),
          json,
        };
      } catch (err) {
        return {
          status: 0,
          ok: false,
          text: err instanceof Error ? err.message : String(err),
          json: null,
        };
      }
    })
    .catch((err) => ({
      status: 0,
      ok: false,
      text: err instanceof Error ? err.message : String(err),
      json: null as any,
    }));

  const blob = `${result.text || ""} ${JSON.stringify(result.json ?? {})}`;
  if (payloadLooksPendingActivation(blob)) {
    return {
      ok: false,
      detail: `API pending activation: ${blob.slice(0, 180)}`,
    };
  }

  const chatId =
    result.json?.chat_id ||
    result.json?.id ||
    result.json?.data?.chat_id ||
    result.json?.data?.id ||
    result.json?.data?.chat?.id;

  if (result.ok && typeof chatId === "string" && chatId.length > 0) {
    return { ok: true, detail: `chat ok (${chatId.slice(0, 12)}…)` };
  }

  // Soft pass only when UI is a real chat shell AND API is not pending/auth-blocked.
    // Rate-limit / 429 with non-pending body can still mean the account is usable.
    // Never soft-pass on 4xx — that means not activated (pending often returns 400).
    if (await pageShowsChatShell(page)) {
      if (
        result.status === 401 ||
        result.status === 403 ||
        result.status === 400
      ) {
        return {
          ok: false,
          detail: `chat shell visível mas API ${result.status}: ${blob.slice(0, 160)}`,
        };
      }
      if (payloadLooksPendingActivation(blob)) {
        return {
          ok: false,
          detail: `chat shell enganoso + API pending: ${blob.slice(0, 160)}`,
        };
      }
      if (
        result.status === 0 ||
        (result.status >= 200 && result.status < 300) ||
        result.status === 429 ||
        result.status === 500 ||
        result.status === 502 ||
        result.status === 503
      ) {
        return {
          ok: true,
          detail: `chat shell ok (probe status=${result.status}; não-pending)`,
        };
      }
    }

    return {
      ok: false,
      detail: `sem chat shell/ativação confirmada (status=${result.status}): ${blob.slice(0, 160)}`,
    };
  }

async function pageShowsAccessVerification(page: Page): Promise<boolean> {
  const text = await page.locator("body").innerText().catch(() => "");
  return /access verification|verify that you are a real person|complete the operation to verify|segurança|security verification|human verification|verifica(?:r|ção) de (?:acesso|segurança)/i.test(
    text,
  );
}

async function openActivationLink(
  page: Page,
  job: RegistrationJob,
  link: string,
): Promise<boolean> {
  // Open verification link in a NEW tab of the SAME browser.
  // Do NOT navigate away from the Qwen "pending activation" confirmation screen.
  const cleanLink = link
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[),.;\]]>]+$/, "");

  setJob(
    job,
    "applying-verification",
    `CLICANDO link de verificação em nova aba: ${cleanLink.slice(0, 100)}…`,
  );

  const ctx = page.context();
  const verifyPage = await ctx.newPage();
  let openedOk = false;
  try {
    const response = await verifyPage
      .goto(cleanLink, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      })
      .catch(() => null);
    await sleep(2_500);

    // Some Qwen emails wrap the real URL; try clicking visible verify CTAs.
    for (const label of [
      "Ativar",
      "Activate",
      "Verify",
      "Verificar",
      "Confirm",
      "Confirmar",
      "Continue",
      "Continuar",
      "Ativar conta",
      "Activate account",
      "Verify email",
      "Verificar e-mail",
    ]) {
      const btn = verifyPage
        .getByRole("button", { name: new RegExp(label, "i") })
        .first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await sleep(1_200);
      }
      const linkBtn = verifyPage
        .getByRole("link", { name: new RegExp(label, "i") })
        .first();
      if (await linkBtn.isVisible().catch(() => false)) {
        await linkBtn.click().catch(() => {});
        await sleep(1_200);
      }
      const textBtn = verifyPage.getByText(label, { exact: false }).first();
      if (await textBtn.isVisible().catch(() => false)) {
        await textBtn.click().catch(() => {});
        await sleep(800);
      }
    }

    // Also click any anchor that looks like a verify/activate action.
    const verifyAnchors = verifyPage.locator(
      'a[href*="verify"], a[href*="activ"], a[href*="confirm"], a[href*="token="]',
    );
    const anchorCount = await verifyAnchors.count().catch(() => 0);
    for (let i = 0; i < Math.min(anchorCount, 3); i++) {
      const a = verifyAnchors.nth(i);
      if (await a.isVisible().catch(() => false)) {
        await a.click().catch(() => {});
        await sleep(1_000);
      }
    }

    await sleep(2_500);
    const finalUrl = verifyPage.url();
    const bodyText = (await verifyPage.locator("body").innerText().catch(() => "")) || "";
    const successUi =
      /activated|ativad|verified|verificad|success|sucesso|conta ativa|account is active|you can now|já pode|login|entrar/i.test(
        bodyText,
      ) || /chat\.qwen\.ai/i.test(finalUrl);

    openedOk =
      Boolean(response) ||
      successUi ||
      /qwen\.ai|alibaba|aliyun/i.test(finalUrl);

    setJob(
      job,
      "applying-verification",
      openedOk
        ? `Link aberto (url=${finalUrl.slice(0, 80)}). Aguardando Qwen limpar pending…`
        : `Link aberto mas resposta fraca (url=${finalUrl.slice(0, 80)}). Continuando…`,
    );
  } finally {
    // keep browser open; closing only the verification tab is fine
    await verifyPage.close().catch(() => {});
  }

  // Stay on the original Qwen confirmation tab and click "Verifique novamente"
  await page.bringToFront().catch(() => {});
  await sleep(1_500);
  for (let i = 0; i < 6; i++) {
    if (!(await pageShowsActivationPending(page))) break;
    await clickByText(page, [
      "Verifique novamente",
      "Check again",
      "Refresh",
      "Já verifiquei",
      "I have verified",
    ]).catch(() => false);
    await sleep(2_000);
  }
  return openedOk;
}


async function clickResendActivation(page: Page): Promise<boolean> {
  // Qwen pending screen:
  //  - "Reenviar e-mail (42s)"  → DISABLED while countdown is active
  //  - "Reenviar e-mail"        → ENABLED
  //  - "Verifique novamente"    → check status only (does NOT resend)
  // Never treat the countdown button or "check again" as a successful resend.
  const candidates = page.locator(
    'button, a, [role="button"], div[class*="btn"], span[class*="btn"]',
  );
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 40); i++) {
    const el = candidates.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const text = ((await el.innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    // Countdown still running — cannot resend yet.
    if (/reenviar|resend/i.test(text) && /\(\s*\d+\s*s\s*\)/i.test(text)) {
      continue;
    }

    const isResend =
      /reenviar\s*e-?mail|resend\s*e-?mail|^reenviar$|^resend$/i.test(text);
    if (!isResend) continue;

    const disabled =
      (await el.isDisabled().catch(() => false)) ||
      (await el.getAttribute("disabled").catch(() => null)) != null ||
      (await el.getAttribute("aria-disabled").catch(() => null)) === "true" ||
      /disabled|opacity-50|cursor-not-allowed/i.test(
        (await el.getAttribute("class").catch(() => "")) || "",
      );
    if (disabled) continue;

    await el.click({ timeout: 5_000 }).catch(() => {});
    await sleep(1_800);
    return true;
  }

  // Fallback: exact-ish text match without countdown suffix.
  for (const label of ["Reenviar e-mail", "Resend email", "Reenviar", "Resend"]) {
    const btn = page.getByText(label, { exact: false }).first();
    if (!(await btn.isVisible().catch(() => false))) continue;
    const text = ((await btn.innerText().catch(() => "")) || "").trim();
    if (/\(\s*\d+\s*s\s*\)/i.test(text)) continue;
    const disabled = await btn.isDisabled().catch(() => false);
    if (disabled) continue;
    await btn.click({ timeout: 5_000 }).catch(() => {});
    await sleep(1_800);
    return true;
  }
  return false;
}

/**
 * Wait until the Qwen resend button leaves the countdown state.
 * Returns true if it looks clickable (or the pending banner disappeared).
 */
async function waitForResendEnabled(
  page: Page,
  timeoutMs = 55_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pageShowsActivationPending(page))) return true;
    const body = ((await page.locator("body").innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ");
    // Still counting down.
    if (/reenviar e-mail\s*\(\s*\d+\s*s\s*\)|resend email\s*\(\s*\d+\s*s\s*\)/i.test(body)) {
      await sleep(1_500);
      continue;
    }
    // Button text present without countdown → try click.
    if (/reenviar e-mail|resend email/i.test(body)) return true;
    await sleep(1_500);
  }
  return false;
}

/**
 * Open mail.tm in a second tab of the SAME browser, login with mailbox credentials,
 * open first message and extract activation link from DOM/HTML.
 */
async function scrapeMailTmInboxInBrowser(
  page: Page,
  job: RegistrationJob,
  mailbox: TempMailbox,
): Promise<string | undefined> {
  if (mailbox.provider !== "mail.tm" || !mailbox.password) return undefined;

  setJob(
    job,
    "pending_activation",
    "Inbox API vazia — abrindo mail.tm no mesmo navegador para buscar o link…",
  );

  const ctx = page.context();
  const inbox = await ctx.newPage();
  try {
    await inbox.goto("https://mail.tm/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await sleep(2_000);

    // Try login UI (mail.tm SPA). Multiple selector strategies.
    // Open login if needed
    await inbox.getByText(/login|entrar|sign in/i).first().click({ timeout: 5_000 }).catch(() => {});
    await sleep(1_000);

    const emailSel = inbox.locator(
      'input[type="email"], input[name="address"], input[name="email"], input[placeholder*="mail" i]',
    ).first();
    const passSel = inbox.locator(
      'input[type="password"], input[name="password"]',
    ).first();

    if (await emailSel.isVisible().catch(() => false)) {
      await emailSel.fill(mailbox.email);
      await passSel.fill(mailbox.password || "");
      await inbox
        .locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Entrar")')
        .first()
        .click()
        .catch(async () => {
          await inbox.keyboard.press("Enter");
        });
      await sleep(3_000);
    } else {
      // Fallback: use API token in localStorage if page supports it
      if (mailbox.token) {
        await inbox.evaluate((token) => {
          try {
            localStorage.setItem("token", token);
            localStorage.setItem("authToken", token);
          } catch {}
        }, mailbox.token);
        await inbox.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(2_000);
      }
    }

    // Click first message-looking item
    const candidates = [
      'a[href*="message"]',
      '[class*="message"]',
      'li',
      'article',
      'div[role="listitem"]',
    ];
    for (const sel of candidates) {
      const items = inbox.locator(sel);
      const n = await items.count();
      for (let i = 0; i < Math.min(n, 8); i++) {
        const it = items.nth(i);
        const txt = ((await it.innerText().catch(() => "")) || "").toLowerCase();
        if (!txt) continue;
        if (/qwen|verify|activa|confirma|security|valid/.test(txt) || txt.length > 10) {
          await it.click().catch(() => {});
          await sleep(1_500);
          break;
        }
      }
    }

    // Extract link from opened message DOM
    const html = await inbox.content().catch(() => "");
    const bodyText = await inbox.locator("body").innerText().catch(() => "");
    const extracted = extractVerification({
      id: "browser-inbox",
      subject: "",
      from: "",
      text: bodyText,
      html,
    });
    if (extracted.link) {
      setJob(
        job,
        "applying-verification",
        `Link encontrado no mail.tm web: ${extracted.link.slice(0, 90)}…`,
      );
      return extracted.link;
    }

    // also scan anchors
    const hrefs = await inbox.$$eval("a[href]", (as) =>
      as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean),
    );
    for (const href of hrefs) {
      if (/qwen|verify|activ|confirm|token=/i.test(href)) {
        return href;
      }
    }
  } catch (err) {
    setJob(
      job,
      "pending_activation",
      `Falha ao abrir mail.tm no browser: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Keep browser open: do not close context; closing only the inbox tab is OK
    await inbox.close().catch(() => {});
  }
  return undefined;
}

async function pageLooksAuthenticated(page: Page): Promise<boolean> {
  // Account still on explicit pending-activation banner is NOT ready.
  if (await pageShowsActivationPending(page)) return false;

  // Hard rule: cookies / qwen_token alone are NOT enough.
  // Pending-activation accounts often already have localStorage token and still
  // fail create-chat with Bad_Request: "Your account is currently pending activation".
  // Only a real chat shell counts as authenticated here.
  return pageShowsChatShell(page);
}

async function detectCaptcha(page: Page): Promise<boolean> {
  if (await pageShowsAccessVerification(page)) return true;
  const selectors = [
    'iframe[src*="captcha"]',
    'iframe[src*="aliyun"]',
    'iframe[src*="nocaptcha"]',
    'iframe[src*="recaptcha"]',
    "#aliyunCaptcha-sliding-slider",
    ".nc_iconfont",
    ".btn_slide",
    '[class*="captcha"]',
    '[id*="captcha"]',
    '[class*="verify"]',
    "text=/verify you are human|security verification|slide to|arraste|verificação|human verification|Access Verification|real person/i",
  ];
  for (const sel of selectors) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function handleCaptcha(
  page: Page,
  job: RegistrationJob,
  timeoutMs: number,
  cdpPort?: number,
): Promise<void> {
  // Prefer Access Verification / puzzle detection
  const visible =
    (await detectCaptcha(page)) ||
    (await isAccessVerificationVisible(page)) ||
    (await pageShowsAccessVerification(page));
  if (!visible) return;

  // Already green Verified — just dismiss and continue
  if (await isCaptchaVerified(page)) {
    setJob(job, "solving-captcha", "Captcha já Verified — fechando overlay…");
    await dismissVerifiedCaptcha(page);
    return;
  }

  setJob(
      job,
      "solving-captcha",
      "CAPTCHA detectado — resolvendo rápido (API CDP open_if_needed → vision)…",
    );

    // Open puzzle once, then hand off to the API immediately.
    await openCaptchaIfNeeded(page);
    await sleep(400);

    const deadline = Date.now() + timeoutMs;
    let attemptRound = 0;
    let triedApi = false;

    while (Date.now() < deadline) {
      if (await pageShowsActivationPending(page)) {
        setJob(
          job,
          "pending_activation",
          "CAPTCHA ok — tela de confirmação de e-mail aberta.",
        );
        return;
      }
      if (await isCaptchaVerified(page)) {
        await dismissVerifiedCaptcha(page);
        setJob(job, "filling-form", "CAPTCHA Verified — seguindo fluxo.");
        return;
      }
      if (await pageLooksAuthenticated(page)) return;

      const stillThere =
        (await isAccessVerificationVisible(page)) ||
        (await pageShowsAccessVerification(page)) ||
        (await detectCaptcha(page));
      if (!stillThere) {
        await sleep(400);
        if (
          !(await isAccessVerificationVisible(page)) &&
          !(await detectCaptcha(page))
        ) {
          setJob(job, "filling-form", "CAPTCHA/verificação sumiu.");
          return;
        }
      }

      attemptRound += 1;

      // 1) API first (fast path). Open once more only if slider not ready.
      if (cdpPort && config.accountCreator.captchaApiEnabled && !triedApi) {
        triedApi = true;
        const sliderReady = await page
          .locator("#aliyunCaptcha-sliding-slider")
          .first()
          .isVisible()
          .catch(() => false);
        if (!sliderReady) await openCaptchaIfNeeded(page);

        setJob(
          job,
          "solving-captcha",
          `Captcha API rápida (CDP :${cdpPort}, ${config.accountCreator.captchaGesture})…`,
        );
        const apiResult = await solveCaptchaViaApi({
          cdpHost: config.accountCreator.cdpHost,
          cdpPort,
          targetUrl: "chat.qwen.ai",
          timeoutMs: Math.min(
            Math.max(20_000, config.accountCreator.captchaJobTimeoutMs),
            Math.max(12_000, deadline - Date.now()),
          ),
        });
        if (apiResult.ok) {
          await sleep(500);
          if (await isCaptchaVerified(page)) await dismissVerifiedCaptcha(page);
          if (await pageShowsActivationPending(page)) {
            setJob(
              job,
              "pending_activation",
              `CAPTCHA ok via API (${apiResult.attempts ?? "?"} tentativas).`,
            );
            return;
          }
          if (await pageLooksAuthenticated(page)) return;
          if (
            !(await isAccessVerificationVisible(page)) &&
            !(await pageShowsAccessVerification(page))
          ) {
            setJob(
              job,
              "filling-form",
              `CAPTCHA ok via API (targetX=${apiResult.targetX ?? "?"}).`,
            );
            return;
          }
          setJob(
            job,
            "solving-captcha",
            "API ok mas widget ainda visível — vision rápido…",
          );
        } else {
          setJob(
            job,
            "solving-captcha",
            `API falhou (${apiResult.error || "unknown"}). Vision…`,
          );
        }
      }

      // 2) Vision fallback — fewer attempts, faster loop.
      if (!(await page.locator("#aliyunCaptcha-sliding-slider").first().isVisible().catch(() => false))) {
        await openCaptchaIfNeeded(page);
      }
      const result = await solveAliyunPuzzleCaptcha(page, {
        maxAttempts: 3,
        onAttempt: ({ attempt, offsetPx, confidence, status }) => {
          setJob(
            job,
            "solving-captcha",
            `Vision r${attemptRound}.${attempt}: ${status}${
              offsetPx != null ? ` · ${offsetPx}px` : ""
            }${confidence != null ? ` · conf ${(confidence * 100).toFixed(0)}%` : ""}`,
          );
        },
      });

      if (result.ok) {
        await sleep(400);
        if (await isCaptchaVerified(page)) await dismissVerifiedCaptcha(page);
        if (await pageShowsActivationPending(page)) {
          setJob(
            job,
            "pending_activation",
            `CAPTCHA ok em ${result.attempts} arraste(s).`,
          );
          return;
        }
        if (await pageLooksAuthenticated(page)) return;
        if (
          !(await isAccessVerificationVisible(page)) &&
          !(await pageShowsAccessVerification(page))
        ) {
          setJob(
            job,
            "filling-form",
            `CAPTCHA ok (offset=${result.offsetPx ?? "?"}px).`,
          );
          return;
        }
      }

      // One API retry only if still stuck.
      if (
        cdpPort &&
        config.accountCreator.captchaApiEnabled &&
        triedApi &&
        attemptRound <= 2
      ) {
        setJob(job, "solving-captcha", "Re-tentativa rápida da Captcha API…");
        await openCaptchaIfNeeded(page);
        const apiRetry = await solveCaptchaViaApi({
          cdpHost: config.accountCreator.cdpHost,
          cdpPort,
          targetUrl: "chat.qwen.ai",
          timeoutMs: Math.min(25_000, Math.max(10_000, deadline - Date.now())),
        });
        if (apiRetry.ok) {
          await sleep(400);
          if (await isCaptchaVerified(page)) await dismissVerifiedCaptcha(page);
          if (
            (await pageShowsActivationPending(page)) ||
            (await pageLooksAuthenticated(page)) ||
            (!(await isAccessVerificationVisible(page)) &&
              !(await pageShowsAccessVerification(page)))
          ) {
            setJob(job, "pending_activation", "CAPTCHA ok na re-tentativa API.");
            return;
          }
        }
      }

      setJob(
        job,
        "solving-captcha",
        `Ainda no captcha (${result.error || "retry"})…`,
      );
      await sleep(400);
    }

    throw new Error(
      "CAPTCHA atual não resolvido a tempo (API CDP + vision). Sem captcha ok o Qwen NÃO envia o e-mail de ativação.",
    );
  }

/**
 * Real Qwen Studio auth form (2026):
 * Login: input[name=email] type=text, input[name=password], "Inscrever-se"
 * Signup: username, email (type=text), password, checkPassword, terms checkbox, "Criar Conta"
 *
 * IMPORTANT: ?mode=register in the URL alone does NOT mean the form is mounted.
 * The SPA often boots on chat shell / login first — we must wait for real fields.
 */
async function openSignupAndFill(
  page: Page,
  email: string,
  password: string,
  displayName: string,
): Promise<void> {
  const fieldLocator = page.locator(
    [
      'input[name="email"]',
      'input[name="username"]',
      'input[name="checkPassword"]',
      'input[type="email"]',
      'input[placeholder*="E-mail" i]',
      'input[placeholder*="Email" i]',
      'input[placeholder*="e-mail" i]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
    ].join(", "),
  );

  const signupMarkers = page.locator(
    [
      'input[name="checkPassword"]',
      'input[name="username"]',
      'button:has-text("Criar Conta")',
      'button:has-text("Create Account")',
      'button:has-text("Sign up")',
      'text=/Inscreva-se no Qwen|Create your account|Criar conta/i',
    ].join(", "),
  );

  async function dismissBlockingUi(): Promise<void> {
    // Cookie / consent / region banners that block the auth form
    const dismissTexts = [
      "Accept",
      "Aceitar",
      "I agree",
      "Concordo",
      "OK",
      "Got it",
      "Entendi",
      "Allow all",
      "Permitir",
      "Close",
      "Fechar",
    ];
    for (const t of dismissTexts) {
      const b = page.getByRole("button", { name: new RegExp(`^${t}$`, "i") }).first();
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 2_000 }).catch(() => {});
      }
    }
    // Escape any modal
    await page.keyboard.press("Escape").catch(() => {});
  }

  async function tryOpenSignupFromLogin(): Promise<void> {
    await clickByText(page, [
      "Inscrever-se",
      "Inscreva-se",
      "Inscrever",
      "Sign up",
      "Create account",
      "Cadastrar",
      "Registrar",
      "Criar conta",
    ]);
    // Role-based (antd buttons sometimes don't match getByText cleanly)
    const roleBtn = page
      .getByRole("button", {
        name: /inscrever|sign up|create account|cadastrar|registrar/i,
      })
      .first();
    if (await roleBtn.isVisible().catch(() => false)) {
      await roleBtn.click({ timeout: 5_000 }).catch(() => {});
    }
    const link = page
      .getByRole("link", {
        name: /inscrever|sign up|create account|cadastrar|registrar/i,
      })
      .first();
    if (await link.isVisible().catch(() => false)) {
      await link.click({ timeout: 5_000 }).catch(() => {});
    }
  }

  async function pageHasSignupForm(): Promise<boolean> {
    return signupMarkers.first().isVisible().catch(() => false);
  }

  async function pageHasAnyAuthField(): Promise<boolean> {
    return fieldLocator.first().isVisible().catch(() => false);
  }

  // Canonical signup URL (NOT bare /?mode=register — that lands on chat shell).
    const entryUrls = [
      "https://chat.qwen.ai/auth?mode=register",
      "https://chat.qwen.ai/auth?tab=signup",
      "https://chat.qwen.ai/auth",
    ];

  let lastDiag = "";
  for (let round = 0; round < entryUrls.length; round++) {
    const url = entryUrls[round];
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await sleep(1_800);
    await dismissBlockingUi();

    // If already logged in from a sticky profile, force logout path
    const alreadyChat =
      (await pageLooksAuthenticated(page)) &&
      !(await pageHasAnyAuthField());
    if (alreadyChat) {
      // Clear site storage so the auth form can appear
      await page
        .context()
        .clearCookies()
        .catch(() => {});
      await page
        .evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
      await page
        .goto("https://chat.qwen.ai/auth", {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        .catch(() => {});
      await sleep(1_500);
      await dismissBlockingUi();
    }

    // Wait a bit for SPA hydrate
    for (let i = 0; i < 8; i++) {
      if (await pageHasSignupForm()) break;
      if (await pageHasAnyAuthField()) {
        // Login form — switch to signup
        await tryOpenSignupFromLogin();
        await sleep(1_000);
        if (await pageHasSignupForm()) break;
      }
      await dismissBlockingUi();
      await sleep(800);
    }

    if (await pageHasSignupForm()) break;
    if (await pageHasAnyAuthField()) {
      await tryOpenSignupFromLogin();
      await sleep(1_200);
      if (await pageHasSignupForm()) break;
    }

    lastDiag = await page
      .evaluate(() => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 220);
        const inputs = Array.from(document.querySelectorAll("input"))
          .slice(0, 8)
          .map((el) => {
            const i = el as HTMLInputElement;
            return `${i.type}|name=${i.name}|ph=${i.placeholder}|vis=${i.offsetParent !== null}`;
          })
          .join("; ");
        return `url=${location.href} | inputs=[${inputs}] | body=${body}`;
      })
      .catch(() => `url=${page.url()}`);
  }

  // Final wait for ANY auth field, then ensure signup
  const fieldVisible = await fieldLocator
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  if (!fieldVisible) {
    const diag =
      lastDiag ||
      (await page
        .evaluate(() =>
          (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 280),
        )
        .catch(() => page.url()));
    throw new Error(
      `Formulário de inscrição do Qwen não apareceu (timeout). ${diag}`,
    );
  }

  if (!(await pageHasSignupForm())) {
    await tryOpenSignupFromLogin();
    await sleep(1_200);
  }

  // Wait specifically for signup markers (checkPassword / Criar Conta)
  const signupReady = await signupMarkers
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!signupReady) {
      // Still only login? force the real register route under /auth
      await page
        .goto("https://chat.qwen.ai/auth?mode=register", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        })
        .catch(() => {});
      await sleep(1_500);
      await tryOpenSignupFromLogin();
      await signupMarkers
        .first()
        .waitFor({ state: "visible", timeout: 12_000 })
        .catch(() => {});
    }

  // Username: keep simple (no accents/spaces that sometimes fail validation)
  const safeName =
    displayName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .slice(0, 24) || `User${Math.floor(Math.random() * 9999)}`;

  const nameOk = await fillByName(page, "username", safeName);
  const emailOk = await fillByName(page, "email", email);
  const passOk = await fillByName(page, "password", password);
  const checkOk = await fillByName(page, "checkPassword", password);

  if (!emailOk) {
    const emailAlt = page
      .locator(
        'input[placeholder*="E-mail" i], input[placeholder*="Email" i], input[name="email"], input[type="email"], input[autocomplete="email"]',
      )
      .first();
    if (await emailAlt.count()) {
      await emailAlt.click({ timeout: 5_000 }).catch(() => {});
      await emailAlt.fill("");
      await emailAlt.fill(email);
      await emailAlt.evaluate((el, v) => {
        const input = el as HTMLInputElement;
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        desc?.set?.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, email);
    } else {
      throw new Error(
        "Campo de e-mail não encontrado no formulário de inscrição do Qwen.",
      );
    }
  }
  if (!passOk) {
    const passAlt = page.locator('input[type="password"]').first();
    if (await passAlt.count()) await passAlt.fill(password);
  }
  if (!checkOk) {
    const pws = page.locator('input[type="password"]');
    if ((await pws.count()) >= 2) await pws.nth(1).fill(password);
  }
  if (!nameOk) {
    const userAlt = page
      .locator(
        'input[name="username"], input[placeholder*="nome" i], input[placeholder*="user" i], input[autocomplete="username"]',
      )
      .first();
    if (await userAlt.count()) {
      await userAlt.fill(safeName);
    }
  }

  // Accept terms checkbox (required — submit stays disabled otherwise)
  await ensureTermsAccepted(page);

  await sleep(500);

  // Some Qwen locales show an inline Aliyun trigger before submit
  const captchaTrigger = page
    .locator(
      '#aliyunCaptcha-captcha-text, #aliyunCaptcha-sliding-slider, text=/Access Verification|Click to start verification|verificar|verificação|real person/i',
    )
    .first();
  if (await captchaTrigger.isVisible().catch(() => false)) {
    await captchaTrigger.click().catch(() => {});
    await sleep(800);
  }

  // Submit — ensure button is enabled
  const submit = page
    .locator(
      'button[type="submit"], button:has-text("Criar Conta"), button:has-text("Create Account"), button:has-text("Sign up")',
    )
    .first();

  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureTermsAccepted(page);
    // Re-fill password fields if React cleared them
    await fillByName(page, "password", password).catch(() => {});
    await fillByName(page, "checkPassword", password).catch(() => {});

    const disabled =
      (await submit.isDisabled().catch(() => false)) ||
      (await submit.getAttribute("disabled").catch(() => null)) != null ||
      (await submit.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (disabled) {
      await ensureTermsAccepted(page);
      await sleep(400);
    }

    await submit.click({ timeout: 10_000 }).catch(async () => {
      await clickByText(page, ["Criar Conta", "Create Account", "Sign up"]);
    });

    // Wait for captcha modal OR activation screen OR leave form
    for (let i = 0; i < 10; i++) {
      if (await pageShowsAccessVerification(page)) return;
      if (await detectCaptcha(page)) return;
      if (await pageShowsActivationPending(page)) return;
      if (await pageLooksAuthenticated(page)) return;
      const stillForm = await page
        .locator(
          'button:has-text("Criar Conta"), button:has-text("Create Account"), input[name="checkPassword"]',
        )
        .first()
        .isVisible()
        .catch(() => false);
      if (!stillForm) return;
      await sleep(600);
    }
  }
}

async function ensureTermsAccepted(page: Page): Promise<void> {
  // Prefer antd checkbox input
  const boxes = page.locator(
    'input.ant-checkbox-input, input[type="checkbox"]',
  );
  const count = await boxes.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 4); i++) {
    const box = boxes.nth(i);
    if (!(await box.isVisible().catch(() => false))) continue;
    const checked = await box.isChecked().catch(() => false);
    if (checked) continue;
    // Click wrapper/label first (antd intercepts)
    const wrapper = page.locator(".ant-checkbox-wrapper, .ant-checkbox").nth(i);
    if (await wrapper.isVisible().catch(() => false)) {
      await wrapper.click({ timeout: 3_000 }).catch(() => {});
    }
    const still = await box.isChecked().catch(() => false);
    if (!still) {
      await box.check({ force: true }).catch(() => {});
      await box.evaluate((el) => {
        const input = el as HTMLInputElement;
        input.checked = true;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }).catch(() => {});
    }
  }

  // Text-based fallback near terms copy
  const termsText = page
    .getByText(/Estou de acordo|I agree|Termos de uso|Terms of (use|service)|Acordo de privacidade|Privacy/i)
    .first();
  if (await termsText.isVisible().catch(() => false)) {
    await termsText.click({ timeout: 3_000 }).catch(() => {});
  }
}


async function fillOtpIfPresent(page: Page, code: string): Promise<boolean> {
  const selectors = [
    'input[name*="code" i]',
    'input[name*="otp" i]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
    'input[placeholder*="code" i]',
    'input[placeholder*="código" i]',
    'input[placeholder*="verifica" i]',
    'input[maxlength="6"]',
    'input[maxlength="8"]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(code);
      await page
        .locator(
          'button[type="submit"], button:has-text("Verify"), button:has-text("Verificar"), button:has-text("Confirm"), button:has-text("Confirmar"), button:has-text("Continue"), button:has-text("Continuar")',
        )
        .first()
        .click()
        .catch(() => {});
      return true;
    }
  }
  // multi-box OTP
  const boxes = page.locator(
    'input[maxlength="1"][type="text"], input[maxlength="1"][type="tel"]',
  );
  const n = await boxes.count();
  if (n >= 4 && n <= 8 && code.length >= n) {
    for (let i = 0; i < n; i++) {
      await boxes.nth(i).fill(code[i] || "");
    }
    return true;
  }
  return false;
}

async function applyVerification(
  page: Page,
  job: RegistrationJob,
  mailbox: TempMailbox,
  signupStartedAt: number,
  mailPage?: Page,
  options: { autoVerifyEmail?: boolean; headless?: boolean } = {},
): Promise<void> {
  // Target system flow:
  // 1) Signup + captcha done → stay pending
  // 2) Poll inbox (tuamaeaquelaursa) automatically
  // 3) When email arrives → MUST open/click verification link automatically
  // 4) Probe API/chat shell — only then continue to pool auth
  // Hard rule: cookies/qwen_token without clicking the email link still fail chat.
  const autoVerify = options.autoVerifyEmail !== false;
  const headless = options.headless === true;

  setJob(
    job,
    "pending_activation",
    headless
      ? `Headless: aguardando e-mail e CLICANDO no link automaticamente (${mailbox.email})…`
      : `Aguardando e-mail e CLICANDO no link automaticamente (${mailbox.email})…`,
  );

  let verification: { code?: string; link?: string; message?: any } | null =
      null;
    let lastMsgCount = 0;
    let resendCount = 0;
    let linkClickAttempts = 0;
    let lastOpenedLink: string | null = null;
    let linkOpenedAtLeastOnce = false;
    // Use the full creator timeout (default 600s). Email delivery can be slow.
        const timeoutMs = Math.max(
          180_000,
          Math.min(config.accountCreator.timeoutMs, 900_000),
        );
        const started = Date.now();
        const deadline = started + timeoutMs;
        const inboxPage = mailPage;
        const seenLinks = new Set<string>();
        let nextResendAt = started + 50_000; // first resend after ~50s (past typical countdown)

        // Early path only if chat shell is already usable AND API is not pending.
        // Never skip inbox just because localStorage has qwen_token.
        {
          const early = await probeAccountActivationFromPage(page);
          if (early.ok && (await pageShowsChatShell(page))) {
            setJob(
              job,
              "applying-verification",
              `Qwen já utilizável sem pending (${early.detail}).`,
            );
            return;
          }
        }

        while (Date.now() < deadline) {
          // After at least one link open, re-check real activation (API / chat shell)
          if (linkOpenedAtLeastOnce) {
            const probe = await probeAccountActivationFromPage(page);
            if (probe.ok) {
              setJob(
                job,
                "applying-verification",
                `Ativação confirmada após clique no link (${probe.detail}).`,
              );
              return;
            }
            setJob(
              job,
              "applying-verification",
              `Link já aberto, ainda pending: ${probe.detail.slice(0, 140)}`,
            );
          } else if (
            (await pageShowsChatShell(page)) &&
            !(await pageShowsActivationPending(page))
          ) {
            const probe = await probeAccountActivationFromPage(page);
            if (probe.ok) {
              setJob(
                job,
                "applying-verification",
                `Chat shell utilizável (${probe.detail}).`,
              );
              return;
            }
          }

          const elapsedMs = Date.now() - started;
          const pending = await pageShowsActivationPending(page);

          // Resend only when the real resend button is enabled (not "Verifique novamente",
          // not "Reenviar e-mail (42s)"). Wait out the countdown first.
          if (pending && resendCount < 6 && Date.now() >= nextResendAt) {
            setJob(
              job,
              "pending_activation",
              `Aguardando botão Reenviar liberar (countdown)… inbox=${lastMsgCount} msg · ${Math.round(elapsedMs / 1000)}s`,
            );
            await waitForResendEnabled(page, 55_000);
            const ok = await clickResendActivation(page);
            if (ok) {
              resendCount += 1;
              nextResendAt = Date.now() + 55_000; // Qwen typically locks ~45-60s
              setJob(
                job,
                "pending_activation",
                `Reenviei e-mail (#${resendCount}). Poll da inbox até o Qwen entregar…`,
              );
            } else {
              nextResendAt = Date.now() + 15_000;
              // Still click "Verifique novamente" as a non-destructive status refresh.
              await clickByText(page, [
                "Verifique novamente",
                "Check again",
                "Refresh",
              ]).catch(() => false);
            }
          }

          // Dedicated automatic inbox poll + link extract.
                    // ONE hard refresh after signup (mail only appears after refresh),
                    // then soft poll — never reload every few seconds.
                    if (inboxPage && mailbox.provider === "tuamaeaquelaursa" && autoVerify) {
                      try {
                        await inboxPage.bringToFront().catch(() => {});
                        const onUrsa = /tuamaeaquelaursa\.com/i.test(inboxPage.url());
                        if (mailbox.login && !onUrsa) {
                          await inboxPage
                            .goto(`https://tuamaeaquelaursa.com/${mailbox.login}`, {
                              waitUntil: "domcontentloaded",
                              timeout: 30_000,
                            })
                            .catch(() => {});
                        }

                        // First wait slice: hard-refresh once so Qwen mail shows up.
                        // Later slices: soft poll only (refreshOnce=false).
                        const isFirstWait = !linkClickAttempts && lastMsgCount === 0 && elapsedMs < 60_000;
                        verification = await waitForUrsaVerificationLink(inboxPage, mailbox, {
                          timeoutMs: 45_000,
                          pollIntervalMs: 2_000,
                          refreshOnce: isFirstWait || elapsedMs < 8_000,
                          onPoll: ({ messages, sample, refreshed }) => {
                            lastMsgCount = messages;
                            setJob(
                              job,
                              "pending_activation",
                              `${refreshed ? "Inbox atualizada · " : ""}${messages} msg · ${Math.round(elapsedMs / 1000)}s · resends=${resendCount}${sample ? ` · ${sample}` : ""}`,
                            );
                          },
                        });
                      } catch {
                        // slice timeout — continue outer loop (no reload spam)
                        await inboxPage.bringToFront().catch(() => {});
                        const msgs = await listUrsaMessages(inboxPage).catch(() => []);
                        lastMsgCount = msgs.length;
                        setJob(
                          job,
                          "pending_activation",
                          `Aguardando e-mail Qwen · ${msgs.length} msg · ${Math.round(elapsedMs / 1000)}s · resends=${resendCount}`,
                        );
                      } finally {
                        // After a wait slice, restore Qwen tab only briefly for resend/probe.
                        await page.bringToFront().catch(() => {});
                      }
                    } else if (mailbox.provider !== "tuamaeaquelaursa" && autoVerify) {
            try {
              verification = await waitForVerificationEmail(mailbox, {
                timeoutMs: 12_000,
                pollIntervalMs: 2_500,
                sinceMs: signupStartedAt - 2_000,
                onPoll: ({ messages }) => {
                  lastMsgCount = messages;
                },
              });
            } catch {
              // continue
            }
          }

          // AUTO CLICK / OPEN verification link as soon as we have it — mandatory.
          if (autoVerify && verification?.link) {
        const link = verification.link.trim();
        const alreadyTried = seenLinks.has(link) && linkClickAttempts >= 3;
        if (!alreadyTried) {
          seenLinks.add(link);
          linkClickAttempts += 1;
          lastOpenedLink = link;
          setJob(
            job,
            "applying-verification",
            `E-mail chegou. CLICANDO link (#${linkClickAttempts}): ${link.slice(0, 100)}…`,
          );
          const opened = await openActivationLink(page, job, link);
          // Count as opened even if response was weak — we did navigate to the link.
          linkOpenedAtLeastOnce = true;
          if (!opened) {
            setJob(
              job,
              "applying-verification",
              "Link navegado com resposta fraca; re-probando ativação…",
            );
          }
          verification = null;

          // Give Qwen time to clear pending after the link click, then hard-probe chat.
          for (let i = 0; i < 18; i++) {
            if (await pageShowsActivationPending(page)) {
              await clickByText(page, [
                "Verifique novamente",
                "Check again",
                "Refresh",
                "Já verifiquei",
                "I have verified",
              ]).catch(() => false);
            }
            // Prefer landing on chat home before probe
            if (
              !/chat\.qwen\.ai/i.test(page.url()) ||
              /\/auth\//i.test(page.url())
            ) {
              await page
                .goto("https://chat.qwen.ai/", {
                  waitUntil: "domcontentloaded",
                  timeout: 45_000,
                })
                .catch(() => {});
            }
            const probe = await probeAccountActivationFromPage(page);
            if (probe.ok) {
              setJob(
                job,
                "applying-verification",
                `Link confirmado e conta ativada (${probe.detail}).`,
              );
              return;
            }
            await sleep(2_000);
          }
          continue;
        }
        verification = null;
      }

      if (verification?.code) {
        job.verificationCode = verification.code;
        await fillOtpIfPresent(page, verification.code).catch(() => false);
      }

      await sleep(1_200);
    }

    // Final hard probe — never claim success from token alone.
    const finalProbe = await probeAccountActivationFromPage(page);
    if (finalProbe.ok) {
      setJob(
        job,
        "applying-verification",
        `Timeout do poll, mas ativação confirmada (${finalProbe.detail}).`,
      );
      return;
    }

    if (!linkOpenedAtLeastOnce) {
      throw new Error(
        `Não chegou e-mail/link de verificação em ${Math.round(timeoutMs / 1000)}s (inbox msgs=${lastMsgCount}). Conta permanece pendente — o link NÃO foi clicado.`,
      );
    }

    throw new Error(
      `Link de verificação foi aberto${lastOpenedLink ? ` (${lastOpenedLink.slice(0, 80)}…)` : ""}, mas a conta ainda está pending activation após ${Math.round(timeoutMs / 1000)}s. Detalhe: ${finalProbe.detail}`,
    );
  }

async function waitSession(
  page: Page,
  job: RegistrationJob,
  timeoutMs: number,
  cdpPort?: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    const signal = await collectSessionSignal(page);
    job.hasCookies = signal.cookieCount > 0;
    const elapsed = Date.now() - started;

    // Dismiss verified captcha overlay that blocks the chat shell
    if (await isCaptchaVerified(page)) {
      setJob(
        job,
        "capturing-session",
        "Captcha Verified no caminho — fechando overlay…",
      );
      await dismissVerifiedCaptcha(page);
    }

    if (await pageShowsActivationPending(page)) {
      if (elapsed % 8_000 < 1_300) {
        setJob(
          job,
          "pending_activation",
          `Ainda na confirmação de e-mail… ${Math.round(elapsed / 1000)}s`,
        );
      }
    } else if (await pageLooksAuthenticated(page)) {
      setJob(
        job,
        "capturing-session",
        `Sessão autenticada (cookies=${signal.cookieCount}).`,
      );
      return true;
    } else {
      // Probe is the ground truth: if create-chat works, account is ready
      // even if Access Verification overlay is still painted.
      const probe = await probeAccountActivationFromPage(page);
      if (probe.ok) {
        if (await isCaptchaVerified(page) || (await isAccessVerificationVisible(page))) {
          await dismissVerifiedCaptcha(page);
        }
        setJob(
          job,
          "capturing-session",
          `Login confirmado via API (${probe.detail}) · cookies=${signal.cookieCount}.`,
        );
        return true;
      }
      if (elapsed % 12_000 < 1_300) {
        setJob(
          job,
          "capturing-session",
          `Confirmando login… ${Math.round(elapsed / 1000)}s · cookies=${signal.cookieCount} · ${probe.detail.slice(0, 80)}`,
        );
      }
    }

    // keep solving captcha if it reappears
    if (
      (await detectCaptcha(page)) ||
      (await isAccessVerificationVisible(page))
    ) {
      await handleCaptcha(page, job, 90_000, cdpPort).catch(() => {});
    }
    await sleep(1_200);
  }
  return false;
}

async function runRegistration(
  job: RegistrationJob,
  request: RegistrationRequest,
): Promise<void> {
  const accountId = crypto.randomUUID();
  const profilePath = path.resolve("data", "qwen_profiles", accountId);
  let context: BrowserContext | undefined;
  let persisted = false;
  let mailbox: TempMailbox | null = null;

  const explicitEmail = Boolean(request.email?.trim());
  const useTempEmail =
    request.useTempEmail === true ||
    (request.useTempEmail !== false && !explicitEmail);

  const password =
    request.password && request.password.length >= 8
      ? request.password
      : generateAccountPassword();
  const displayName = request.displayName?.trim() || generateDisplayName();

  try {
    let email = request.email?.trim() || "";

    fs.mkdirSync(profilePath, { recursive: true });
    // Qwen shows "Access Verification" captcha on signup. Headless almost always fails
    // there, so no activation email is ever sent. Default to HEADED for account creation.
    // Force headless only with ACCOUNT_CREATOR_FORCE_HEADLESS=true (not recommended).
    const forceHeadless =
      process.env.ACCOUNT_CREATOR_FORCE_HEADLESS === "true" ||
      process.env.ACCOUNT_CREATOR_FORCE_HEADLESS === "1";
    // Default HEADED so Aliyun/Access Verification can be solved. Headless blocks signup.
    const headless = forceHeadless;

    // GLM-style: expose CDP so the external Aliyun solver API can attach.
        const cdpPort = await reserveCdpPort();

        // Pre-start captcha API so the first puzzle after "Criar Conta" is solved fast.
        if (config.accountCreator.captchaApiEnabled) {
          setJob(
            job,
            "opening-browser",
            "Subindo Captcha API local (Aliyun CDP) se necessário…",
          );
          const captchaReady = await ensureCaptchaApi().catch(() => false);
          if (!captchaReady) {
            console.warn(
              "⚠️  [Registration] Captcha API offline no boot — usará vision fallback se o puzzle aparecer.",
            );
          }
        }

        setJob(
              job,
              "opening-browser",
              headless
                ? `Abrindo navegador headless + CDP :${cdpPort} (pode falhar no CAPTCHA)…`
                : `Abrindo navegador visível + CDP :${cdpPort} (Captcha API GLM / fallback vision; depois clica o link do e-mail)…`,
            );

        // Prefer real Chrome channel when available so Firebase/ursa behaves like
        // the user's normal browser (bundled Chromium often throttles background
        // websockets / fails to hydrate the inbox).
        let contextLaunchError: string | null = null;
        try {
          context = await chromium.launchPersistentContext(profilePath, {
            headless,
            channel: "chrome",
            viewport: { width: 1280, height: 860 },
            locale: "pt-BR",
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-blink-features=AutomationControlled",
              "--no-sandbox",
              `--remote-debugging-port=${cdpPort}`,
              "--remote-debugging-address=127.0.0.1",
              // Keep timers/websockets alive on background tabs (ursa inbox).
              "--disable-background-timer-throttling",
              "--disable-backgrounding-occluded-windows",
              "--disable-renderer-backgrounding",
              "--disable-features=CalculateNativeWinOcclusion",
            ],
          });
          setJob(
            job,
            "opening-browser",
            `Chrome real + CDP :${cdpPort} (melhor para inbox Firebase da ursa).`,
          );
        } catch (err) {
          contextLaunchError =
            err instanceof Error ? err.message : String(err);
          context = await chromium.launchPersistentContext(profilePath, {
            headless,
            viewport: { width: 1280, height: 860 },
            locale: "pt-BR",
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-blink-features=AutomationControlled",
              "--no-sandbox",
              `--remote-debugging-port=${cdpPort}`,
              "--remote-debugging-address=127.0.0.1",
              "--disable-background-timer-throttling",
              "--disable-backgrounding-occluded-windows",
              "--disable-renderer-backgrounding",
              "--disable-features=CalculateNativeWinOcclusion",
            ],
          });
          setJob(
            job,
            "opening-browser",
            `Chromium bundled + CDP :${cdpPort} (fallback; chrome channel falhou: ${contextLaunchError.slice(0, 80)}).`,
          );
        }

        // glm-style: two tabs in the SAME browser
        // mailPage = tuamaeaquelaursa inbox | page = Qwen signup
        const mailPage = context.pages()[0] ?? (await context.newPage());
        const page = await context.newPage();
        let signupStartedAt = Date.now();

        if (useTempEmail || !email) {
          setJob(
            job,
            "preparing-email",
            "Criando e-mail na tuamaeaquelaursa (aba inbox em FOREGROUND para Firebase)…",
          );
          // Create mailbox on mail tab. Keep it focused long enough for the
          // Firestore listener to connect before switching to Qwen.
          mailbox = await createTempMailbox(mailPage);
          email = mailbox.email;
          job.email = email;
          job.provider = mailbox.provider;
          await mailPage.bringToFront().catch(() => {});
          await sleep(2_000);
          setJob(
            job,
            "preparing-email",
            `E-mail pronto: ${email} (${mailbox.provider}). Inbox fica aberta; durante a espera ela volta ao foco.`,
          );
        } else {
          job.email = email;
          job.provider = "user-provided";
        }

    if (!email.includes("@")) throw new Error("E-mail inválido.");

    setJob(job, "filling-form", `Preenchendo inscrição do Qwen para ${email}…`);
        await page.bringToFront().catch(() => {});
        signupStartedAt = Date.now();
        await openSignupAndFill(page, email, password, displayName);

        // Post-submit loop: captcha / pending email / leave form.
        // Do NOT fail immediately if still on form — re-submit after captcha attempts.
        for (let round = 0; round < 3; round++) {
          await sleep(1_200);

          if (await pageShowsActivationPending(page)) break;
          if (await pageLooksAuthenticated(page)) break;

          if (
            (await pageShowsAccessVerification(page)) ||
            (await detectCaptcha(page)) ||
            (await isCaptchaVerified(page))
          ) {
            await handleCaptcha(
              page,
              job,
              Math.min(180_000, config.accountCreator.timeoutMs),
              cdpPort,
            );
            // After captcha, form often auto-submits; wait a bit
            await sleep(1_500);
            if (await pageShowsActivationPending(page)) break;
            if (await pageLooksAuthenticated(page)) break;
          }

          const stillOnForm = await page
            .locator(
              'input[name="checkPassword"], button:has-text("Criar Conta"), button:has-text("Create Account")',
            )
            .first()
            .isVisible()
            .catch(() => false);

          if (!stillOnForm) break;

          // Still on form: re-accept terms + re-submit
          setJob(
            job,
            "filling-form",
            `Ainda na inscrição (rodada ${round + 1}/3) — reenviando formulário…`,
          );
          await ensureTermsAccepted(page);
          await fillByName(page, "password", password).catch(() => {});
          await fillByName(page, "checkPassword", password).catch(() => {});
          await fillByName(page, "email", email).catch(() => {});
          const submit = page
            .locator(
              'button[type="submit"], button:has-text("Criar Conta"), button:has-text("Create Account")',
            )
            .first();
          await submit.click({ timeout: 8_000 }).catch(() => {});
          await sleep(1_500);
        }

        // HARD GATE: do not claim "pending email" unless Qwen actually shows activation screen
        // or we are already authenticated. Headless often dies at Access Verification with no email sent.
        if (await pageShowsAccessVerification(page)) {
          // One last captcha attempt before giving up
          await handleCaptcha(
            page,
            job,
            Math.min(120_000, config.accountCreator.timeoutMs),
            cdpPort,
          );
        }
        if (
          (await pageShowsAccessVerification(page)) &&
          !(await isCaptchaVerified(page)) &&
          !(await pageShowsActivationPending(page)) &&
          !(await pageLooksAuthenticated(page))
        ) {
          throw new Error(
            "Qwen bloqueou com Access Verification (CAPTCHA). O e-mail NÃO é enviado até o captcha passar.",
          );
        }

        // Still on signup form? fields visible means submit failed
        const stillOnForm = await page
          .locator(
            'input[name="checkPassword"], button:has-text("Criar Conta"), button:has-text("Create Account")',
          )
          .first()
          .isVisible()
          .catch(() => false);
        if (
          stillOnForm &&
          !(await pageShowsActivationPending(page)) &&
          !(await pageLooksAuthenticated(page))
        ) {
          // Collect validation messages if any
          const errBits = await page
            .locator(
              ".ant-form-item-explain-error, .ant-form-item-has-error, [role='alert'], .error",
            )
            .allInnerTexts()
            .catch(() => [] as string[]);
          const body = (
            (await page.locator("body").innerText().catch(() => "")) || ""
          )
            .replace(/\s+/g, " ")
            .slice(0, 280);
          throw new Error(
            `Cadastro não avançou da tela de inscrição (sem e-mail enviado).${
              errBits.length ? ` Erros: ${errBits.join(" | ").slice(0, 160)}.` : ""
            } UI: ${body}`,
          );
        }

    if (await pageShowsActivationPending(page)) {
      setJob(
        job,
        "pending_activation",
        "Conta criada. Tela de confirmação de e-mail aberta. Aguardando link na inbox…",
      );
    } else if (await pageLooksAuthenticated(page)) {
          setJob(
            job,
            "capturing-session",
            "Conta já autenticada no Qwen após o cadastro.",
          );
        } else if (mailbox) {
          // Soft wait: activation screen / chat / captcha may appear with delay.
          // Captcha after "Criar Conta" is normal — keep solving automatically.
          setJob(
            job,
            "pending_activation",
            "Aguardando tela de confirmação de e-mail do Qwen…",
          );
          const softDeadline = Date.now() + 90_000;
          while (Date.now() < softDeadline) {
            if (await pageShowsActivationPending(page)) break;
            if (await pageLooksAuthenticated(page)) break;
            if (
              (await pageShowsAccessVerification(page)) ||
              (await detectCaptcha(page))
            ) {
              setJob(
                job,
                "solving-captcha",
                "CAPTCHA pós-criação detectado — resolvendo automaticamente…",
              );
              await handleCaptcha(
                page,
                job,
                Math.min(180_000, deadlineRemaining(softDeadline)),
                cdpPort,
              );
              continue;
            }
            await sleep(1_500);
          }
          if (
            !(await pageShowsActivationPending(page)) &&
            !(await pageLooksAuthenticated(page))
          ) {
            // Last attempt: captcha may still be blocking the transition
            if (
              (await pageShowsAccessVerification(page)) ||
              (await detectCaptcha(page))
            ) {
              await handleCaptcha(page, job, 120_000, cdpPort);
            }
          }
          if (
            !(await pageShowsActivationPending(page)) &&
            !(await pageLooksAuthenticated(page))
          ) {
            throw new Error(
              "Qwen não mostrou a tela de confirmação de e-mail nem o chat. Cadastro provavelmente bloqueado no CAPTCHA; e-mail não será enviado.",
            );
          }
        }

    if (mailbox) {
      try {
        await applyVerification(page, job, mailbox, signupStartedAt, mailPage, { autoVerifyEmail: true, headless });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("abort:")) {
          setJob(
            job,
            "pending_activation",
            "Sessão parcial detectada; mantendo tela de confirmação e inbox abertas…",
          );
          await applyVerification(page, job, mailbox, signupStartedAt, mailPage, { autoVerifyEmail: true, headless });
        } else {
          throw err;
        }
      }

      // Only AFTER confirmation/login is ready: ensure chat session then pool auth
            setJob(
              job,
              "authenticating",
              "Confirmação ok. Confirmando login no Qwen (captcha pós-login se aparecer)…",
            );
            await page.bringToFront().catch(() => {});

            // After activation link, Qwen often asks captcha again before chat is usable.
            for (let loginRound = 0; loginRound < 3; loginRound++) {
              if (await pageLooksAuthenticated(page)) break;
              if (await pageShowsActivationPending(page)) break;

              if (
                (await pageShowsAccessVerification(page)) ||
                (await detectCaptcha(page))
              ) {
                await handleCaptcha(
                  page,
                  job,
                  Math.min(120_000, config.accountCreator.timeoutMs),
                  cdpPort,
                );
                continue;
              }

              await page
                .goto("https://chat.qwen.ai/", {
                  waitUntil: "domcontentloaded",
                  timeout: 45_000,
                })
                .catch(() => {});
              await sleep(1_500);

              if (await pageLooksAuthenticated(page)) break;

              // Login form (pt-BR / en)
              const emailField = page
                .locator(
                  'input[name="email"], input[type="email"], input[name="username"], input[placeholder*="E-mail" i], input[placeholder*="Email" i]',
                )
                .first();
              const passField = page.locator('input[type="password"], input[name="password"]').first();
              if (
                (await emailField.isVisible().catch(() => false)) &&
                (await passField.isVisible().catch(() => false))
              ) {
                setJob(
                  job,
                  "authenticating",
                  `Fazendo login com ${email} (rodada ${loginRound + 1}/3)…`,
                );
                await emailField.click({ timeout: 5_000 }).catch(() => {});
                await emailField.fill(email);
                await passField.click({ timeout: 5_000 }).catch(() => {});
                await passField.fill(password);
                await page
                  .locator(
                    'button[type="submit"], button:has-text("Log in"), button:has-text("Entrar"), button:has-text("Sign in"), button:has-text("Login")',
                  )
                  .first()
                  .click()
                  .catch(() => {});
                await sleep(2_000);
              }

              await handleCaptcha(
                page,
                job,
                Math.min(120_000, config.accountCreator.timeoutMs),
                cdpPort,
              );

              const probe = await probeAccountActivationFromPage(page);
              if (probe.ok) {
                setJob(
                  job,
                  "authenticating",
                  `Login confirmado (${probe.detail}).`,
                );
                break;
              }
            }

            if (await pageLooksAuthenticated(page)) {
              setJob(
                job,
                "authenticating",
                "Qwen já logado no chat. Indo autenticar no pool…",
              );
            }
    } else if (await pageShowsActivationPending(page)) {
      // User-provided email: keep browser open and wait for manual link click / activation.
      setJob(
        job,
        "pending_activation",
        "Pendente de ativação. Abra o link do e-mail (navegador permanece aberto)…",
      );
      const deadline = Date.now() + Math.min(config.accountCreator.timeoutMs, 600_000);
      while (Date.now() < deadline) {
        if (!(await pageShowsActivationPending(page)) && (await pageLooksAuthenticated(page))) {
          break;
        }
        await sleep(2_000);
      }
      if (await pageShowsActivationPending(page)) {
        throw new Error(
          "Conta ainda pendente de ativação (link do e-mail não confirmado).",
        );
      }
    }

    // Hard gate: never continue while activation is still pending.
    // Cookies / qwen_token alone are NOT enough — must pass API probe.
    if (await pageShowsActivationPending(page)) {
      throw new Error(
        "Conta pendente de ativação. O link do e-mail ainda não foi confirmado no navegador.",
      );
    }
    {
      const probe = await probeAccountActivationFromPage(page);
      if (!probe.ok) {
        throw new Error(
          `Conta ainda não ativada após o fluxo de e-mail: ${probe.detail}`,
        );
      }
      setJob(
        job,
        "capturing-session",
        `Ativação confirmada via probe: ${probe.detail}`,
      );
    }

    setJob(
          job,
          "capturing-session",
          "E-mail ativado. Validando sessão autenticada (confirmando login)…",
        );
        const ok = await waitSession(
          page,
          job,
          Math.min(180_000, config.accountCreator.timeoutMs),
          cdpPort,
        );
        if (!ok || (await pageShowsActivationPending(page))) {
          throw new Error(
            "Sessão autenticada não obtida (ativação de e-mail ainda pendente ou captcha pós-login).",
          );
        }
        {
          const probe = await probeAccountActivationFromPage(page);
          if (!probe.ok) {
            throw new Error(
              `Sessão capturada mas conta ainda pending activation: ${probe.detail}`,
            );
          }
          setJob(
            job,
            "capturing-session",
            `Login confirmado no chat: ${probe.detail}`,
          );
        }

        // Keep browser open a bit after activation so cookies settle, then close profile for pool reuse.
        setJob(
          job,
          "capturing-session",
          "Ativação OK. Gravando sessão no perfil (5s)…",
        );
        await sleep(5_000);
        await context.close();
        context = undefined;

        setJob(
          job,
          "authenticating",
          "Salvando conta e autenticando no pool (headers bx-ua)…",
        );
        const account = addAccount(email, password, accountId);
        persisted = true;
        job.accountId = account.id;

        // Pool auth can show captcha again — use headed=false by config, but
        // initPlaywright will re-login with credentials if cookies need refresh.
        setJob(
          job,
          "authenticating",
          "Confirmando login no pool Playwright e capturando bx-ua…",
        );
        let poolAuthError: string | null = null;
        try {
          await initPlaywrightForAccount(account, config.playwright.headless);
        } catch (err) {
          poolAuthError = err instanceof Error ? err.message : String(err);
          // Retry once headed-ish if headless login failed (captcha often blocks headless)
          setJob(
            job,
            "authenticating",
            `Pool auth falhou (${poolAuthError.slice(0, 80)}). Retentando…`,
          );
          await initPlaywrightForAccount(account, false);
        }

        let hasHeaders = accountHasCapturedHeaders(account.id);
        if (!hasHeaders) {
          setJob(
            job,
            "authenticating",
            "Sessão aberta, capturando headers bx-* para o pool…",
          );
          hasHeaders = await ensureAccountHeaders(account.id, true);
        }
        if (!hasHeaders) {
          // One more force capture after short wait
          await sleep(2_000);
          hasHeaders = await ensureAccountHeaders(account.id, true);
        }
        if (!hasHeaders) {
          throw new Error(
            "Conta autenticou no browser de cadastro, mas headers bx-ua não foram capturados no pool (conta não está pronta para o proxy).",
          );
        }

        job.ready = true;
        setJob(
          job,
          "completed",
          "Conta PRONTA: captcha + e-mail + login confirmado + headers no pool.",
        );
  } catch (error) {
    if (persisted) removeAccount(accountId);
    await fs.promises
      .rm(profilePath, { recursive: true, force: true })
      .catch(() => {});
    job.ready = false;
    const message = error instanceof Error ? error.message : String(error);
    setJob(job, "failed", "Falha ao criar conta pronta.", message);
  } finally {
    await context?.close().catch(() => {});
  }
}

export function startRegistration(
  request: RegistrationRequest = {},
): RegistrationJob {
  const explicitEmail = Boolean(request.email?.trim());
  const useTempEmail =
    request.useTempEmail === true ||
    (request.useTempEmail !== false && !explicitEmail);

  if (!useTempEmail) {
    const email = request.email?.trim() || "";
    if (!email.includes("@")) throw new Error("Informe um e-mail válido.");
  }
  if (request.password && request.password.length < 8) {
    throw new Error("A senha deve ter pelo menos 8 caracteres.");
  }

  const now = Date.now();
  const job: RegistrationJob = {
    id: crypto.randomUUID(),
    email: request.email?.trim() || "(gerando e-mail temp…)",
    state: "queued",
    message:
      "Fila: temp-mail → form Qwen → captcha → verify e-mail → auth pool.",
    createdAt: now,
    updatedAt: now,
    ready: false,
  };
  jobs.set(job.id, job);
  void runRegistration(job, request);
  return publicJob(job);
}
