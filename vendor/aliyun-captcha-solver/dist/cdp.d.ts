import type { GestureTuning, TrackPoint } from './trajectory.js';
export interface CDPClient {
    Runtime: any;
    Page: any;
    Input: any;
    Network: any;
    DOM: any;
    Browser?: any;
    Target?: any;
    close(): Promise<void>;
}
interface InstallCaptchaHookOptions {
    captureFullDragTrace?: boolean;
}
export interface CaptchaNetworkRequest {
    ts: number;
    requestId: string;
    url: string;
    method: string;
    postData: string;
}
export interface CaptchaNetworkResponse {
    ts: number;
    requestId: string;
    url: string;
    status: number;
    mimeType: string;
    body: string;
    base64Encoded: boolean;
}
export declare function connectCDP(host?: string, port?: number, targetUrl?: string): Promise<CDPClient>;
export declare function evaluate<T>(client: CDPClient, expression: string): Promise<T>;
export declare function evaluateWithTimeout<T>(client: CDPClient, expression: string, timeout: number): Promise<T>;
export declare function waitForSelector(client: CDPClient, selector: string, timeout?: number): Promise<void>;
export interface PuzzleImages {
    backgroundBase64: string;
    puzzleBase64: string;
    bgNaturalWidth: number;
    bgNaturalHeight: number;
    pzNaturalWidth: number;
    pzNaturalHeight: number;
    imgBoxRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    sliderRect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}
export declare function extractPuzzleImages(client: CDPClient): Promise<PuzzleImages>;
export declare function clickTrigger(client: CDPClient): Promise<void>;
export interface DragResult {
    sliderMoved: boolean;
    puzzleMoved: boolean;
    sliderLeftBefore: string;
    sliderLeftAfter: string;
    puzzleLeftAfter: string;
    sliderExists: boolean;
    mousedownFired: boolean;
    trackPoints: number;
    method: string;
    correctionApplied: boolean;
    correctionDelta: number;
    correctionMoves: number;
    fineTuneMoves: number;
    gestureDurationMs: number;
    preReleaseLivePosition: {
        sliderLeft: number;
        puzzleLeft: number;
    } | null;
    releasePointer: {
        x: number;
        y: number;
    } | null;
    lastMoveToReleaseMs: number | null;
    previousMovePhaseBeforeRelease: DragDispatchEvent['phase'] | null;
    releaseTimingBreakdown: ReleaseTimingBreakdown | null;
    finalPhaseDispatchDegraded: boolean;
    dispatchTrace: DragDispatchEvent[];
    dispatchSummary: DragDispatchSummary;
}
export interface ReleaseTimingBreakdown {
    pendingFlushBeforeCorrectionMs: number;
    initialStabilityWaitMs: number;
    preCorrectionSettleMs: number;
    correctionLoopMs: number;
    postCorrectionLiveReadMs: number;
    finalStabilityWaitMs: number;
    preReleaseHoverMs: number;
    finalHoverDispatchMs: number;
    beforeReleaseCallbackMs: number;
    preReleaseRandomSleepMs: number;
    releaseDispatchCallMs: number;
    totalMeasuredBeforeReleaseMs: number;
}
export interface DragDispatchEvent {
    seq: number;
    phase: 'approach' | 'press' | 'track' | 'correction' | 'final_hover' | 'release';
    cdpType: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
    tsBefore: number;
    tsAfter: number;
    x: number;
    y: number;
    buttons?: number;
    button?: 'left';
    plannedTrackT?: number | null;
}
export interface DragDispatchSummary {
    totalEvents: number;
    moveEvents: number;
    pressEvents: number;
    releaseEvents: number;
    totalSpanMs: number;
    dispatchSpanMs: number;
    maxGapMs: number;
    maxDispatchCallMs: number;
    avgDispatchCallMs: number;
    longGapCount: number;
}
export interface ScreenshotClip {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
}
export declare function dragSlider(client: CDPClient, tracks: TrackPoint[], startX: number, startY: number, targetPuzzleLeft?: number, onReleased?: () => Promise<void>, tuning?: GestureTuning, onBeforeRelease?: () => Promise<void>): Promise<DragResult>;
export interface CaptchaResult {
    success: boolean;
    captchaText: string;
    fullState: string;
    captchaVerifyParam: string | null;
    verifyCode: string | null;
    sliderMoved: boolean;
    puzzleMoved: boolean;
    certifyIdChanged: boolean;
    currentCertifyId: string;
    hasSuccessClass: boolean;
    hasFailureMessage: boolean;
    timedOut: boolean;
    failureReason: string | null;
    hookSuccess: boolean;
    verifyResponseSuccess: boolean;
}
export declare function getCertifyId(client: CDPClient): Promise<string>;
export declare function checkCaptchaResult(client: CDPClient, prevCertifyId: string): Promise<CaptchaResult>;
export declare function installCaptchaHook(client: CDPClient, options?: InstallCaptchaHookOptions): Promise<void>;
export declare function captureScreenshot(client: CDPClient, clip?: ScreenshotClip): Promise<Buffer>;
export declare function captureElementScreenshot(client: CDPClient, selector: string): Promise<Buffer | null>;
export declare function readCapturedParam(client: CDPClient): Promise<{
    param: string | null;
    success: boolean;
    log: Array<{
        event: string;
        ts: number;
        [k: string]: any;
    }>;
}>;
export declare function readCaptchaNetworkTrace(client: CDPClient): Promise<{
    requests: CaptchaNetworkRequest[];
    responses: CaptchaNetworkResponse[];
}>;
export declare function resetCaptchaNetworkTrace(client: CDPClient): void;
export declare function resetCaptchaObservation(client: CDPClient): Promise<void>;
export declare function interceptCaptchaParam(client: CDPClient): Promise<string | null>;
export declare function sleep(ms: number): Promise<void>;
export {};
