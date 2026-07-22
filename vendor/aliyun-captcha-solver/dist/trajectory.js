import { buildHumanReplayTrack as buildLibraryHumanReplayTrack } from './human-replay.js';
function envNumber(name) {
    const raw = process.env[name];
    if (!raw)
        return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}
function envRange(nameMin, nameMax, fallback) {
    const min = envNumber(nameMin);
    const max = envNumber(nameMax);
    return [
        min ?? fallback[0],
        max ?? fallback[1],
    ];
}
function applyGestureEnvOverrides(profile, tuning) {
    const prefix = `SOLVER_${profile.toUpperCase()}`;
    return {
        ...tuning,
        initialHoldMs: envRange(`${prefix}_INITIAL_HOLD_MS_MIN`, `${prefix}_INITIAL_HOLD_MS_MAX`, tuning.initialHoldMs),
        preCorrectionSettleMs: envRange(`${prefix}_PRE_CORRECTION_SETTLE_MS_MIN`, `${prefix}_PRE_CORRECTION_SETTLE_MS_MAX`, tuning.preCorrectionSettleMs),
        correctionMoveDelayMs: envRange(`${prefix}_CORRECTION_MOVE_DELAY_MS_MIN`, `${prefix}_CORRECTION_MOVE_DELAY_MS_MAX`, tuning.correctionMoveDelayMs),
        correctionReadDelayMs: envRange(`${prefix}_CORRECTION_READ_DELAY_MS_MIN`, `${prefix}_CORRECTION_READ_DELAY_MS_MAX`, tuning.correctionReadDelayMs),
        preReleaseHoverMs: envRange(`${prefix}_PRE_RELEASE_HOVER_MS_MIN`, `${prefix}_PRE_RELEASE_HOVER_MS_MAX`, tuning.preReleaseHoverMs),
        correctionMaxMoves: envNumber(`${prefix}_CORRECTION_MAX_MOVES`) ?? tuning.correctionMaxMoves,
        correctionMaxStep: envNumber(`${prefix}_CORRECTION_MAX_STEP`) ?? tuning.correctionMaxStep,
        correctionTolerance: envNumber(`${prefix}_CORRECTION_TOLERANCE`) ?? tuning.correctionTolerance,
        finalAlignMaxMoves: envNumber(`${prefix}_FINAL_ALIGN_MAX_MOVES`) ?? tuning.finalAlignMaxMoves,
        finalAlignTrigger: envNumber(`${prefix}_FINAL_ALIGN_TRIGGER`) ?? tuning.finalAlignTrigger,
        finalAlignTolerance: envNumber(`${prefix}_FINAL_ALIGN_TOLERANCE`) ?? tuning.finalAlignTolerance,
        finalAlignStepMax: envNumber(`${prefix}_FINAL_ALIGN_STEP_MAX`) ?? tuning.finalAlignStepMax,
        finalPointerJitterX: envNumber(`${prefix}_FINAL_POINTER_JITTER_X`) ?? tuning.finalPointerJitterX,
        finalPointerJitterY: envNumber(`${prefix}_FINAL_POINTER_JITTER_Y`) ?? tuning.finalPointerJitterY,
        postReleaseObserveMs: envNumber(`${prefix}_POST_RELEASE_OBSERVE_MS`) ?? tuning.postReleaseObserveMs,
        livePositionReadTimeoutMs: envNumber(`${prefix}_LIVE_POSITION_READ_TIMEOUT_MS`) ?? tuning.livePositionReadTimeoutMs,
    };
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}
function buildHumanReplayTrack(distance) {
    const replayTrack = buildLibraryHumanReplayTrack(distance);
    if (!replayTrack) {
        return buildDirectFastTrack(distance);
    }
    return replayTrack;
}
function buildSettleBackTrack(distance) {
    const tracks = [];
    const safeDistance = Math.max(distance, 1);
    const overshoot = safeDistance > 140 ? 1 + Math.floor(Math.random() * 2) : safeDistance > 90 ? 1 : 0;
    const baseDistance = safeDistance + overshoot;
    const steps = clamp(Math.round(safeDistance / 5) + 12, 40, 58);
    const pauseIndex = Math.max(5, Math.min(steps - 6, Math.round(steps * (0.52 + Math.random() * 0.14))));
    const pauseMs = 45 + Math.round(Math.random() * 65);
    let x = 0;
    let t = 0;
    let yDrift = 0;
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const eased = easeOutCubic(progress);
        const rawX = Math.round(eased * baseDistance + (Math.random() - 0.5) * (progress < 0.85 ? 0.9 : 0.4));
        const maxTarget = i === steps ? baseDistance : baseDistance - Math.max(0, Math.round((steps - i) / 10));
        const nextX = clamp(Math.max(x + 1, rawX), 1, maxTarget);
        let dt = progress < 0.2
            ? 12 + Math.round(Math.random() * 7)
            : progress < 0.78
                ? 14 + Math.round(Math.random() * 10)
                : 18 + Math.round(Math.random() * 14);
        if (i === pauseIndex) {
            dt += pauseMs;
        }
        if (i === steps - 1 && overshoot > 0) {
            dt += 18 + Math.round(Math.random() * 18);
        }
        t += dt;
        x = nextX;
        yDrift = clamp(yDrift + (Math.random() - 0.5) * 0.34, -1.35, 1.35);
        const y = yDrift +
            Math.sin(progress * Math.PI) * (0.18 + Math.random() * 0.14) +
            (Math.random() - 0.5) * 0.22;
        tracks.push({ x, y, t });
    }
    if (overshoot > 0) {
        t += 28 + Math.round(Math.random() * 20);
        tracks.push({
            x: safeDistance,
            y: yDrift * 0.35 + (Math.random() - 0.5) * 0.24,
            t,
        });
    }
    t += 36 + Math.round(Math.random() * 28);
    tracks.push({
        x: safeDistance,
        y: yDrift * 0.16 + (Math.random() - 0.5) * 0.12,
        t,
    });
    t += 24 + Math.round(Math.random() * 20);
    tracks.push({ x: safeDistance, y: 0, t });
    return tracks;
}
function buildMonotonicSoftTrack(distance) {
    const tracks = [];
    const safeDistance = Math.max(distance, 1);
    const steps = clamp(Math.round(safeDistance / 5) + 12, 38, 54);
    const pauseIndex = Math.max(5, Math.min(steps - 5, Math.round(steps * (0.48 + Math.random() * 0.12))));
    const pauseMs = 28 + Math.round(Math.random() * 36);
    let x = 0;
    let t = 0;
    let yDrift = 0;
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const eased = easeOutCubic(progress);
        const rawX = Math.round(eased * safeDistance + (Math.random() - 0.5) * (progress < 0.78 ? 0.7 : 0.35));
        const maxTarget = i === steps ? safeDistance : safeDistance - Math.max(0, Math.round((steps - i) / 9));
        const nextX = clamp(Math.max(x + 1, rawX), 1, maxTarget);
        let dt = progress < 0.16
            ? 11 + Math.round(Math.random() * 6)
            : progress < 0.74
                ? 13 + Math.round(Math.random() * 8)
                : 17 + Math.round(Math.random() * 10);
        if (i === pauseIndex) {
            dt += pauseMs;
        }
        t += dt;
        x = nextX;
        yDrift = clamp(yDrift + (Math.random() - 0.5) * 0.28, -1.1, 1.1);
        const y = yDrift +
            Math.sin(progress * Math.PI) * (0.14 + Math.random() * 0.1) +
            (Math.random() - 0.5) * 0.18;
        tracks.push({ x, y, t });
    }
    t += 28 + Math.round(Math.random() * 18);
    tracks.push({
        x: safeDistance,
        y: yDrift * 0.12 + (Math.random() - 0.5) * 0.08,
        t,
    });
    t += 18 + Math.round(Math.random() * 14);
    tracks.push({ x: safeDistance, y: 0, t });
    return tracks;
}
function buildDirectFastTrack(distance) {
    const tracks = [];
    const safeDistance = Math.max(distance, 1);
    // Keep direct_fast in the historical bot range that previously produced
    // short, decisive drags instead of long queued walks.
    const steps = clamp(Math.round(safeDistance / 6) + 10, 35, 42);
    const hesitationIndex = Math.max(5, Math.min(steps - 6, Math.round(steps * (0.42 + Math.random() * 0.12))));
    const hesitationMs = 14 + Math.round(Math.random() * 18);
    let x = 0;
    let t = 0;
    let yDrift = 0;
    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const eased = easeOutCubic(progress);
        const rawX = Math.round(eased * safeDistance + (Math.random() - 0.5) * (progress < 0.75 ? 0.9 : 0.35));
        const maxTarget = i === steps
            ? safeDistance
            : safeDistance - Math.max(0, Math.round((steps - i) / 9));
        const minAdvance = progress < 0.2
            ? 3
            : progress < 0.72
                ? 4
                : 2;
        const maxAdvance = progress < 0.2
            ? 9
            : progress < 0.72
                ? 10
                : progress < 0.9
                    ? 8
                    : 6;
        const upperBound = Math.min(maxTarget, x + maxAdvance);
        const lowerBound = Math.min(upperBound, x + minAdvance);
        const nextX = clamp(rawX, lowerBound, upperBound);
        let dt = progress < 0.18
            ? 8 + Math.round(Math.random() * 4)
            : progress < 0.74
                ? 10 + Math.round(Math.random() * 6)
                : 13 + Math.round(Math.random() * 7);
        if (i === hesitationIndex) {
            dt += hesitationMs;
        }
        if (progress > 0.86) {
            dt += 6 + Math.round(Math.random() * 8);
        }
        t += dt;
        x = nextX;
        yDrift = clamp(yDrift + (Math.random() - 0.5) * 0.34, -1.1, 1.1);
        tracks.push({
            x,
            y: yDrift +
                Math.sin(progress * Math.PI) * (0.12 + Math.random() * 0.1) +
                (Math.random() - 0.5) * 0.22,
            t,
        });
        if (x >= safeDistance) {
            break;
        }
    }
    t += 12 + Math.round(Math.random() * 10);
    tracks.push({
        x: safeDistance,
        y: yDrift * 0.08 + (Math.random() - 0.5) * 0.04,
        t,
    });
    t += 14 + Math.round(Math.random() * 10);
    tracks.push({ x: safeDistance, y: 0, t });
    return tracks;
}
export function resolveGestureProfile(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'monotonic_soft' || raw === 'monotonic' || raw === 'soft') {
        return 'monotonic_soft';
    }
    if (raw === 'direct_fast' || raw === 'direct' || raw === 'fast') {
        return 'direct_fast';
    }
    if (raw === 'human_replay' || raw === 'replay' || raw === 'human') {
        return 'human_replay';
    }
    return 'settle_back';
}
export function resolveGestureTuning(profile) {
    const base = (() => {
        switch (profile) {
            case 'monotonic_soft':
                return {
                    initialHoldMs: [58, 92],
                    dispatchMode: 'queued',
                    useLiveCorrection: true,
                    preserveTrackTiming: false,
                    skipWarmupMoves: false,
                    preCorrectionSettleMs: [16, 28],
                    correctionMoveDelayMs: [10, 18],
                    correctionReadDelayMs: [10, 16],
                    preReleaseHoverMs: [45, 75],
                    correctionMaxMoves: 6,
                    correctionMaxStep: 10,
                    correctionTolerance: 0.9,
                    finalAlignMaxMoves: 0,
                    finalAlignTrigger: 1.1,
                    finalAlignTolerance: 0.35,
                    finalAlignStepMax: 1.5,
                    finalPointerJitterX: 0.35,
                    finalPointerJitterY: 0.22,
                    postReleaseObserveMs: 170,
                    livePositionReadTimeoutMs: 900,
                };
            case 'direct_fast':
                return {
                    initialHoldMs: [42, 70],
                    dispatchMode: 'queued',
                    useLiveCorrection: true,
                    preserveTrackTiming: false,
                    skipWarmupMoves: false,
                    preCorrectionSettleMs: [8, 18],
                    correctionMoveDelayMs: [7, 13],
                    correctionReadDelayMs: [8, 12],
                    preReleaseHoverMs: [14, 28],
                    correctionMaxMoves: 6,
                    correctionMaxStep: 18,
                    correctionTolerance: 0.6,
                    finalAlignMaxMoves: 4,
                    finalAlignTrigger: 6,
                    finalAlignTolerance: 0.22,
                    finalAlignStepMax: 1.8,
                    finalPointerJitterX: 0.2,
                    finalPointerJitterY: 0.16,
                    postReleaseObserveMs: 140,
                    livePositionReadTimeoutMs: 700,
                };
            case 'human_replay':
                return {
                    initialHoldMs: [0, 12],
                    // The replay track already carries human pacing and dwell points.
                    // Re-queueing and densifying it distorts the DOM-observed drag cycle.
                    dispatchMode: 'sequential',
                    useLiveCorrection: false,
                    preserveTrackTiming: true,
                    skipWarmupMoves: true,
                    preCorrectionSettleMs: [18, 32],
                    correctionMoveDelayMs: [12, 22],
                    correctionReadDelayMs: [12, 20],
                    preReleaseHoverMs: [0, 8],
                    correctionMaxMoves: 4,
                    correctionMaxStep: 8,
                    correctionTolerance: 1.8,
                    finalAlignMaxMoves: 0,
                    finalAlignTrigger: 0,
                    finalAlignTolerance: 0.5,
                    finalAlignStepMax: 0,
                    finalPointerJitterX: 0.16,
                    finalPointerJitterY: 0.18,
                    postReleaseObserveMs: 180,
                    livePositionReadTimeoutMs: 900,
                };
            default:
                return {
                    initialHoldMs: [80, 140],
                    dispatchMode: 'sequential',
                    useLiveCorrection: true,
                    preserveTrackTiming: false,
                    skipWarmupMoves: false,
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
        }
    })();
    return applyGestureEnvOverrides(profile, base);
}
export function generateHumanTrack(distance, profile = 'settle_back') {
    switch (profile) {
        case 'monotonic_soft':
            return buildMonotonicSoftTrack(distance);
        case 'direct_fast':
            return buildDirectFastTrack(distance);
        case 'human_replay': {
            // Without isolated-runs templates, human_replay returns null and
            // the solver crashes on tracks.length. Fall back to settle_back.
            const replay = buildHumanReplayTrack(distance);
            if (replay && Array.isArray(replay) && replay.length > 0) {
                return replay;
            }
            return buildSettleBackTrack(distance);
        }
        default:
            return buildSettleBackTrack(distance);
    }
}
//# sourceMappingURL=trajectory.js.map