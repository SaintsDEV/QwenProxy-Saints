export function parseBooleanEnvFlag(value, defaultValue) {
    if (value == null) {
        return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return defaultValue;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return defaultValue;
}
export function readViewportMutationPolicy(env = process.env) {
    const allowAnyViewportMutation = parseBooleanEnvFlag(env.SOLVER_ALLOW_VIEWPORT_MUTATION, false);
    return {
        allowInPlaceRecovery: parseBooleanEnvFlag(env.SOLVER_ALLOW_INPLACE_VIEWPORT_RECOVERY, allowAnyViewportMutation),
        allowViewportNormalization: parseBooleanEnvFlag(env.SOLVER_ALLOW_VIEWPORT_NORMALIZATION, allowAnyViewportMutation),
    };
}
//# sourceMappingURL=cdp-viewport-policy.js.map