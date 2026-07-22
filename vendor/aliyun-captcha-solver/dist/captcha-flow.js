export function tryParseJson(text) {
    if (typeof text !== 'string')
        return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
export function tryParseForm(text) {
    if (typeof text !== 'string' || !text.includes('='))
        return null;
    try {
        const params = new URLSearchParams(text);
        const out = {};
        for (const [key, value] of params.entries()) {
            if (!(key in out))
                out[key] = value;
        }
        return Object.keys(out).length ? out : null;
    }
    catch {
        return null;
    }
}
export function shortHash(input) {
    if (!input)
        return null;
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
export function classifyCaptchaEvent(url, body) {
    const form = tryParseForm(body);
    const json = tryParseJson(body);
    const resultJson = json?.Result && typeof json.Result === 'object' && !Array.isArray(json.Result)
        ? json.Result
        : null;
    const resultVerifyCode = typeof resultJson?.VerifyCode === 'string'
        ? resultJson.VerifyCode
        : typeof resultJson?.verifyCode === 'string'
            ? resultJson.verifyCode
            : null;
    const resultVerifyResult = typeof resultJson?.VerifyResult === 'boolean'
        ? resultJson.VerifyResult
        : typeof resultJson?.verifyResult === 'boolean'
            ? resultJson.verifyResult
            : null;
    const captchaVerifyParamRaw = form?.CaptchaVerifyParam || form?.captchaVerifyParam || null;
    const captchaVerifyParamJson = tryParseJson(captchaVerifyParamRaw);
    const captchaVerifyParamData = captchaVerifyParamJson && typeof captchaVerifyParamJson.data === 'string'
        ? captchaVerifyParamJson.data
        : null;
    const captchaVerifyParamDeviceToken = captchaVerifyParamJson && typeof captchaVerifyParamJson.deviceToken === 'string'
        ? captchaVerifyParamJson.deviceToken
        : null;
    const action = form?.Action ||
        form?.action ||
        json?.Action ||
        json?.action ||
        resultVerifyCode ||
        json?.VerifyCode ||
        json?.Code ||
        null;
    const lowUrl = String(url || '').toLowerCase();
    let label = action;
    if (!label) {
        if (lowUrl.includes('upload.captcha'))
            label = 'UploadLog';
        else if (lowUrl.includes('captcha-open'))
            label = 'InitCaptcha';
        else if (lowUrl.includes('cloudauth-device'))
            label = 'AliyunDevice';
    }
    return {
        label,
        form,
        json,
        certifyId: form?.CertifyId ||
            form?.certifyId ||
            resultJson?.CertifyId ||
            resultJson?.certifyId ||
            json?.CertifyId ||
            json?.certifyId ||
            null,
        verifyCode: form?.VerifyCode ||
            form?.Code ||
            resultVerifyCode ||
            json?.VerifyCode ||
            json?.verifyCode ||
            json?.code ||
            json?.Code ||
            null,
        captchaVerifyParamInfo: captchaVerifyParamJson
            ? {
                sceneId: typeof captchaVerifyParamJson.sceneId === 'string' ? captchaVerifyParamJson.sceneId : null,
                certifyId: typeof captchaVerifyParamJson.certifyId === 'string'
                    ? captchaVerifyParamJson.certifyId
                    : null,
                dataLength: captchaVerifyParamData?.length ?? 0,
                dataHash: shortHash(captchaVerifyParamData),
                deviceTokenLength: captchaVerifyParamDeviceToken?.length ?? 0,
                deviceTokenHash: shortHash(captchaVerifyParamDeviceToken),
            }
            : null,
        success: resultVerifyResult !== null
            ? resultVerifyResult
            : typeof json?.Success === 'boolean'
                ? json.Success
                : typeof json?.success === 'boolean'
                    ? json.success
                    : null,
    };
}
export function extractVerifyCode(responses, expectedCertifyId) {
    for (let i = responses.length - 1; i >= 0; i--) {
        const body = String(responses[i]?.body || '');
        const certifyIdMatch = body.match(/"certifyId"\s*:\s*"([^"]+)"/i) ||
            body.match(/"CertifyId"\s*:\s*"([^"]+)"/i);
        const certifyId = certifyIdMatch ? String(certifyIdMatch[1] || '').trim() : '';
        if (expectedCertifyId && certifyId && certifyId !== expectedCertifyId) {
            continue;
        }
        const match = body.match(/"VerifyCode"\s*:\s*"([^"]+)"/i);
        if (match)
            return String(match[1] || '').trim().toUpperCase();
    }
    return null;
}
export function resolveVerifyCode(responses, pageVerifyCode, expectedCertifyId) {
    const networkVerifyCode = extractVerifyCode(responses, expectedCertifyId);
    if (networkVerifyCode)
        return networkVerifyCode;
    const normalizedPageVerifyCode = String(pageVerifyCode || '').trim().toUpperCase();
    return normalizedPageVerifyCode || null;
}
export function isSuccessfulAttemptOutcome(verifyCode, result) {
    const normalizedVerifyCode = String(verifyCode || '').trim().toUpperCase();
    if (normalizedVerifyCode && normalizedVerifyCode !== 'T001')
        return false;
    if (result.hasFailureMessage || result.timedOut || result.certifyIdChanged)
        return false;
    return normalizedVerifyCode === 'T001' || result.verifyResponseSuccess;
}
//# sourceMappingURL=captcha-flow.js.map