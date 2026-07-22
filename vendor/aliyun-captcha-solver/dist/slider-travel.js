function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function interpolateAnchorValue(value, anchors) {
    if (anchors.length === 0) {
        return value;
    }
    if (anchors.length === 1) {
        return anchors[0][1];
    }
    if (value <= anchors[0][0]) {
        const [x0, y0] = anchors[0];
        const [x1, y1] = anchors[1] || anchors[0];
        const slope = x1 === x0 ? 1 : (y1 - y0) / (x1 - x0);
        return y0 + (value - x0) * slope;
    }
    for (let i = 1; i < anchors.length; i++) {
        const [leftX, leftY] = anchors[i - 1];
        const [rightX, rightY] = anchors[i];
        if (value <= rightX) {
            const span = rightX - leftX;
            const ratio = span === 0 ? 0 : (value - leftX) / span;
            return leftY + (rightY - leftY) * ratio;
        }
    }
    const [x0, y0] = anchors[anchors.length - 2] || anchors[0];
    const [x1, y1] = anchors[anchors.length - 1];
    const slope = x1 === x0 ? 1 : (y1 - y0) / (x1 - x0);
    return y1 + (value - x1) * slope;
}
function shouldUseHumanSliderTravel(gestureProfile) {
    return gestureProfile === 'direct_fast' || gestureProfile === 'human_replay';
}
export function estimateSliderTravelX(targetDisplayX, gestureProfile, mode = 'bot') {
    if (mode !== 'bot' || !shouldUseHumanSliderTravel(gestureProfile)) {
        return targetDisplayX;
    }
    const enabled = String(process.env.SOLVER_HUMAN_SLIDER_TRAVEL ?? '1').trim() !== '0';
    if (!enabled) {
        return targetDisplayX;
    }
    // Human T001 baseline maps puzzle target -> observed slider/pointer travel.
    const humanSliderAnchors = [
        [151, 195],
        [160, 203],
        [170, 207],
        [182, 216],
        [193, 222],
        [204, 229],
        [216, 236],
        [228, 242],
        [240, 250],
        [249, 254],
    ];
    const estimated = interpolateAnchorValue(targetDisplayX, humanSliderAnchors);
    return clamp(Math.round(estimated), 0, 260);
}
//# sourceMappingURL=slider-travel.js.map