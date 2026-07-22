export interface ClassifiedCaptchaEvent {
    label: string | null;
    form: Record<string, string> | null;
    json: Record<string, any> | null;
    certifyId: string | null;
    verifyCode: string | null;
    captchaVerifyParamInfo: {
        sceneId: string | null;
        certifyId: string | null;
        dataLength: number;
        dataHash: string | null;
        deviceTokenLength: number;
        deviceTokenHash: string | null;
    } | null;
    success: boolean | null;
}
export interface VerifyResponseEntry {
    body: string;
}
export interface AttemptOutcomeResultLike {
    hasFailureMessage: boolean;
    timedOut: boolean;
    certifyIdChanged: boolean;
    verifyResponseSuccess: boolean;
}
export declare function tryParseJson(text: unknown): Record<string, any> | null;
export declare function tryParseForm(text: unknown): Record<string, string> | null;
export declare function shortHash(input: string | null | undefined): string | null;
export declare function classifyCaptchaEvent(url: string | null | undefined, body: string | null | undefined): ClassifiedCaptchaEvent;
export declare function extractVerifyCode(responses: VerifyResponseEntry[], expectedCertifyId?: string | null): string | null;
export declare function resolveVerifyCode(responses: VerifyResponseEntry[], pageVerifyCode: string | null | undefined, expectedCertifyId?: string | null): string | null;
export declare function isSuccessfulAttemptOutcome(verifyCode: string | null, result: AttemptOutcomeResultLike): boolean;
