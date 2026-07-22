const DEFAULT_TARGET_ORIGIN = 'https://chat.z.ai';
function tryParseUrl(value) {
    try {
        return new URL(value);
    }
    catch {
        return null;
    }
}
export function scoreTargetUrlMatch(target, targetUrl) {
    if (target.type !== 'page') {
        return -1;
    }
    const requested = String(targetUrl || '').trim();
    if (!requested) {
        return 1;
    }
    const candidateUrl = String(target.url || '').trim();
    if (!candidateUrl) {
        return -1;
    }
    if (candidateUrl === requested) {
        return 500;
    }
    const parsedCandidate = tryParseUrl(candidateUrl);
    const parsedRequested = tryParseUrl(requested);
    if (parsedCandidate && parsedRequested) {
        if (parsedCandidate.href === parsedRequested.href) {
            return 480;
        }
        if (parsedCandidate.origin === parsedRequested.origin &&
            parsedCandidate.pathname === parsedRequested.pathname &&
            parsedCandidate.search === parsedRequested.search) {
            return 460;
        }
        if (parsedCandidate.href.startsWith(parsedRequested.href)) {
            return 430;
        }
    }
    if (requested.startsWith('/') && parsedCandidate) {
        const candidatePathWithSearch = `${parsedCandidate.pathname}${parsedCandidate.search}`;
        const preferredOrigin = parsedCandidate.origin === DEFAULT_TARGET_ORIGIN;
        if (candidatePathWithSearch === requested) {
            return preferredOrigin ? 420 : 180;
        }
        if (parsedCandidate.pathname === requested) {
            return preferredOrigin ? 390 : 150;
        }
    }
    if (parsedCandidate) {
        if (parsedCandidate.hostname === requested) {
            return 320;
        }
        if (parsedCandidate.origin.includes(requested)) {
            return 260;
        }
    }
    if (candidateUrl.includes(requested)) {
        return 220;
    }
    return -1;
}
export function filterMatchingPageTargets(targets, targetUrl) {
    return targets
        .map((target, index) => ({
        target,
        index,
        score: scoreTargetUrlMatch(target, targetUrl),
        urlLength: String(target.url || '').length,
    }))
        .filter((entry) => entry.score >= 0)
        .sort((left, right) => (right.score - left.score ||
        right.urlLength - left.urlLength ||
        left.index - right.index))
        .map((entry) => ({
        ...entry.target,
        matchScore: entry.score,
    }));
}
//# sourceMappingURL=cdp-targeting.js.map