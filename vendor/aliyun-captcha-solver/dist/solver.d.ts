import type { MatchResult } from './vision.js';
import type { GestureProfile } from './trajectory.js';
export interface SolveOptions {
    host?: string;
    port?: number;
    targetUrl?: string;
    captchaOpenMode?: CaptchaOpenMode | string;
    maxRetries?: number;
    tolerance?: number;
    verbose?: boolean;
    waitForPuzzleTimeout?: number;
    debugScreenshots?: boolean;
    debugDir?: string;
    targetOffset?: number;
    targetBias?: number;
    gestureProfile?: GestureProfile | string;
    reuseOpenCaptcha?: boolean;
    captureFullDragTrace?: boolean;
}
export type CaptchaOpenMode = 'captcha_only' | 'open_if_needed';
export interface SolveResult {
    success: boolean;
    attempts: number;
    targetX: number;
    confidence: number;
    captchaVerifyParam: string | null;
    matchResult: MatchResult;
    debugDir?: string | null;
    error?: string;
}
export declare function solve(options?: SolveOptions): Promise<SolveResult>;
