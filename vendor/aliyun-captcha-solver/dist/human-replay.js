import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
let cachedLibrary = null;
function envNumber(name) {
    const raw = process.env[name];
    if (!raw)
        return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function resolvePath(rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}
function resolveTemplateOverridePath() {
    const raw = String(process.env.SOLVER_HUMAN_TEMPLATE || '').trim();
    return raw ? resolvePath(raw) : null;
}
function resolveLibraryDir() {
    const configured = String(process.env.SOLVER_HUMAN_TEMPLATE_DIR || process.env.SOLVER_HUMAN_LIBRARY_DIR || '').trim();
    if (configured) {
        return resolvePath(configured);
    }
    return path.resolve(process.cwd(), 'isolated-runs', '2026-06-17T16-54-19-661Z');
}
function findStartEvent(events) {
    return events.find((event) => event.phase === 'drag_start' || event.type === 'pointerdown') || null;
}
function findReleaseEvent(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.phase === 'drag_release' || event.type === 'pointerup') {
            return event;
        }
    }
    return null;
}
function computePointerYRange(events, startY) {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const event of events) {
        if (event.type !== 'pointermove' || typeof event.y !== 'number') {
            continue;
        }
        const y = event.y - startY;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return null;
    }
    return maxY - minY;
}
function readJsonFile(filePath) {
    try {
        if (!existsSync(filePath))
            return null;
        return JSON.parse(readFileSync(filePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function buildCandidateFromTemplate(template, filePath, summary) {
    const events = Array.isArray(template.events) ? template.events : [];
    if (events.length === 0) {
        return null;
    }
    const start = findStartEvent(events);
    const release = findReleaseEvent(events);
    if (!start ||
        !release ||
        typeof start.x !== 'number' ||
        typeof start.y !== 'number' ||
        typeof release.x !== 'number') {
        return null;
    }
    const sourceTravelX = Math.max(1, Math.round(release.x - start.x));
    const targetDisplayX = Number(summary?.targetDisplayX ?? template.targetDisplayX ?? 0);
    if (!Number.isFinite(targetDisplayX) || targetDisplayX <= 0) {
        return null;
    }
    const releasePositionErrorPx = summary?.releasePositionErrorPx;
    return {
        attemptName: path.basename(path.dirname(filePath)),
        filePath,
        targetDisplayX,
        sourceTravelX,
        releaseErrorAbs: typeof releasePositionErrorPx === 'number' && Number.isFinite(releasePositionErrorPx)
            ? Math.abs(releasePositionErrorPx)
            : null,
        releaseLagMs: typeof template.summary?.timeLastMoveToReleaseMs === 'number' &&
            Number.isFinite(template.summary.timeLastMoveToReleaseMs)
            ? template.summary.timeLastMoveToReleaseMs
            : null,
        dragDurationMs: typeof template.summary?.dragDurationMs === 'number' && Number.isFinite(template.summary.dragDurationMs)
            ? template.summary.dragDurationMs
            : null,
        moveEventCount: typeof template.summary?.moveEventCount === 'number' && Number.isFinite(template.summary.moveEventCount)
            ? template.summary.moveEventCount
            : events.filter((event) => event.type === 'pointermove').length,
        yRange: computePointerYRange(events, start.y),
        template,
    };
}
function loadOverrideCandidate(filePath) {
    const template = readJsonFile(filePath);
    if (!template) {
        return null;
    }
    const summaryPath = path.join(path.dirname(filePath), 'summary.json');
    const summary = readJsonFile(summaryPath);
    return buildCandidateFromTemplate(template, filePath, summary);
}
function loadLibraryCandidates(dirPath) {
    if (!existsSync(dirPath)) {
        return [];
    }
    const candidates = [];
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^attempt-\d+$/i.test(entry.name)) {
            continue;
        }
        const attemptDir = path.join(dirPath, entry.name);
        const summary = readJsonFile(path.join(attemptDir, 'summary.json'));
        if (String(summary?.verifyCode || '').toUpperCase() !== 'T001') {
            continue;
        }
        const templatePath = path.join(attemptDir, 'human-trajectory.json');
        const template = readJsonFile(templatePath);
        if (!template) {
            continue;
        }
        const candidate = buildCandidateFromTemplate(template, templatePath, summary);
        if (candidate) {
            candidates.push(candidate);
        }
    }
    return candidates;
}
function buildLibraryKey() {
    return [
        resolveTemplateOverridePath() || '-',
        resolveLibraryDir(),
        envNumber('SOLVER_HUMAN_MAX_RELEASE_ERROR_PX') ?? 6,
        envNumber('SOLVER_HUMAN_MAX_RELEASE_LAG_MS') ?? 25,
        envNumber('SOLVER_HUMAN_MIN_Y_RANGE_PX') ?? 8,
        envNumber('SOLVER_HUMAN_TARGET_Y_RANGE_PX') ?? 14,
    ].join('|');
}
function loadHumanReplayLibrary() {
    const key = buildLibraryKey();
    if (cachedLibrary?.key === key) {
        return cachedLibrary;
    }
    const templateOverride = resolveTemplateOverridePath();
    if (templateOverride) {
        const candidate = loadOverrideCandidate(templateOverride);
        cachedLibrary = {
            key,
            preferred: candidate ? [candidate] : [],
            fallback: candidate ? [candidate] : [],
        };
        return cachedLibrary;
    }
    const maxReleaseErrorPx = envNumber('SOLVER_HUMAN_MAX_RELEASE_ERROR_PX') ?? 6;
    const maxReleaseLagMs = envNumber('SOLVER_HUMAN_MAX_RELEASE_LAG_MS') ?? 25;
    const minYRangePx = envNumber('SOLVER_HUMAN_MIN_Y_RANGE_PX') ?? 8;
    const fallback = loadLibraryCandidates(resolveLibraryDir());
    const preferred = fallback.filter((candidate) => {
        const releaseErrorOk = candidate.releaseErrorAbs == null || candidate.releaseErrorAbs <= maxReleaseErrorPx;
        const releaseLagOk = candidate.releaseLagMs == null || candidate.releaseLagMs <= maxReleaseLagMs;
        const yRangeOk = candidate.yRange == null || candidate.yRange >= minYRangePx;
        return releaseErrorOk && releaseLagOk && yRangeOk;
    });
    cachedLibrary = { key, preferred, fallback };
    return cachedLibrary;
}
function compareNumbers(left, right) {
    return left === right ? 0 : left < right ? -1 : 1;
}
function candidateYRangeDelta(candidate) {
    const targetYRangePx = envNumber('SOLVER_HUMAN_TARGET_Y_RANGE_PX') ?? 14;
    return Math.abs((candidate.yRange ?? targetYRangePx) - targetYRangePx);
}
function chooseReplayCandidate(distance) {
    const library = loadHumanReplayLibrary();
    const pool = library.preferred.length > 0 ? library.preferred : library.fallback;
    if (pool.length === 0) {
        return null;
    }
    return [...pool].sort((left, right) => {
        const leftTravelDelta = Math.abs(left.sourceTravelX - distance);
        const rightTravelDelta = Math.abs(right.sourceTravelX - distance);
        if (leftTravelDelta !== rightTravelDelta) {
            return compareNumbers(leftTravelDelta, rightTravelDelta);
        }
        const leftError = left.releaseErrorAbs ?? Number.POSITIVE_INFINITY;
        const rightError = right.releaseErrorAbs ?? Number.POSITIVE_INFINITY;
        if (leftError !== rightError) {
            return compareNumbers(leftError, rightError);
        }
        const leftLag = left.releaseLagMs ?? Number.POSITIVE_INFINITY;
        const rightLag = right.releaseLagMs ?? Number.POSITIVE_INFINITY;
        if (leftLag !== rightLag) {
            return compareNumbers(leftLag, rightLag);
        }
        const leftYRangeDelta = candidateYRangeDelta(left);
        const rightYRangeDelta = candidateYRangeDelta(right);
        if (leftYRangeDelta !== rightYRangeDelta) {
            return compareNumbers(leftYRangeDelta, rightYRangeDelta);
        }
        const leftDurationDelta = Math.abs((left.dragDurationMs ?? 3000) - 3000);
        const rightDurationDelta = Math.abs((right.dragDurationMs ?? 3000) - 3000);
        if (leftDurationDelta !== rightDurationDelta) {
            return compareNumbers(leftDurationDelta, rightDurationDelta);
        }
        return left.attemptName.localeCompare(right.attemptName);
    })[0] || null;
}
export function buildHumanReplayTrack(distance) {
    const candidate = chooseReplayCandidate(distance);
    if (!candidate) {
        return null;
    }
    const rawEvents = Array.isArray(candidate.template.events) ? candidate.template.events : [];
    const start = findStartEvent(rawEvents);
    if (!start || typeof start.x !== 'number' || typeof start.y !== 'number' || typeof start.ts !== 'number') {
        return null;
    }
    const startX = start.x;
    const startY = start.y;
    const startTs = start.ts;
    const safeDistance = Math.max(distance, 1);
    const scale = safeDistance / candidate.sourceTravelX;
    let lastT = -1;
    const points = [];
    for (const event of rawEvents) {
        if (event.type !== 'pointermove')
            continue;
        if (typeof event.x !== 'number' || typeof event.y !== 'number' || typeof event.ts !== 'number')
            continue;
        const elapsed = Math.max(0, event.ts - startTs);
        if (elapsed < lastT)
            continue;
        points.push({
            x: clamp((event.x - startX) * scale, 0, safeDistance),
            y: event.y - startY,
            t: elapsed,
        });
        lastT = elapsed;
    }
    if (points.length < 20) {
        return null;
    }
    const last = points[points.length - 1];
    if (Math.abs(last.x - safeDistance) > 0.25) {
        points.push({
            x: safeDistance,
            y: last.y,
            t: last.t + 20,
        });
    }
    return points;
}
//# sourceMappingURL=human-replay.js.map