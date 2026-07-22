export type CaptchaOpenMode = 'captcha_only' | 'open_if_needed';
export interface BrowserTarget {
    host: string;
    port: number;
}
export interface SolveApiRequest {
    browser?: Partial<BrowserTarget>;
    cdp?: Partial<BrowserTarget>;
    host?: string;
    port?: number;
    cdpPort?: number;
    targetUrl?: string;
    captchaOpenMode?: string;
    mode?: string;
    retries?: number;
    maxRetries?: number;
    waitForPuzzleTimeout?: number;
    verbose?: boolean;
    debugScreenshots?: boolean;
    debugDir?: string;
    gestureProfile?: string;
    targetOffset?: number;
    targetBias?: number;
    reuseOpenCaptcha?: boolean;
    captureFullDragTrace?: boolean;
    lightDragTrace?: boolean;
}
export interface NormalizedSolveRequest {
    browser: BrowserTarget;
    browserKey: string;
    targetUrl: string;
    captchaOpenMode: CaptchaOpenMode;
    maxRetries: number;
    waitForPuzzleTimeout?: number;
    verbose: boolean;
    debugScreenshots?: boolean;
    debugDir?: string;
    gestureProfile?: string;
    targetOffset?: number;
    targetBias?: number;
    reuseOpenCaptcha?: boolean;
    captureFullDragTrace?: boolean;
}
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'error';
export interface ApiError {
    message: string;
    code?: string;
    details?: unknown;
}
export interface ApiSolveResult {
    success: boolean;
    attempts: number;
    targetX: number;
    confidence: number;
    captchaVerifyParam: string | null;
    debugDir?: string | null;
    error?: string;
}
export interface SolveJob {
    id: string;
    status: JobStatus;
    request: NormalizedSolveRequest;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    result?: ApiSolveResult;
    error?: ApiError;
}
export interface PublicSolveJob {
    id: string;
    status: JobStatus;
    browser: BrowserTarget;
    browserKey: string;
    targetUrl: string;
    captchaOpenMode: CaptchaOpenMode;
    maxRetries: number;
    debugScreenshots?: boolean;
    debugDir?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    result?: ApiSolveResult;
    error?: ApiError;
}
export interface QueueStats {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    error: number;
    browsers: Record<string, {
        queued: number;
        running: number;
    }>;
}
