export interface TrackPoint {
    x: number;
    y: number;
    t: number;
}
export type GestureProfile = 'settle_back' | 'monotonic_soft' | 'direct_fast' | 'human_replay';
export interface GestureTuning {
    dispatchMode: 'sequential' | 'queued';
    useLiveCorrection: boolean;
    preserveTrackTiming: boolean;
    skipWarmupMoves: boolean;
    initialHoldMs: [number, number];
    preCorrectionSettleMs: [number, number];
    correctionMoveDelayMs: [number, number];
    correctionReadDelayMs: [number, number];
    preReleaseHoverMs: [number, number];
    correctionMaxMoves: number;
    correctionMaxStep: number;
    correctionTolerance: number;
    finalAlignMaxMoves: number;
    finalAlignTrigger: number;
    finalAlignTolerance: number;
    finalAlignStepMax: number;
    finalPointerJitterX: number;
    finalPointerJitterY: number;
    postReleaseObserveMs: number;
    livePositionReadTimeoutMs: number;
}
export declare function resolveGestureProfile(value?: string | null): GestureProfile;
export declare function resolveGestureTuning(profile: GestureProfile): GestureTuning;
export declare function generateHumanTrack(distance: number, profile?: GestureProfile): TrackPoint[];
