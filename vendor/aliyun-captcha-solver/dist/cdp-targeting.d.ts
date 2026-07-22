export interface CDPTargetSummary {
    id?: string;
    matchScore?: number;
    title?: string;
    type?: string;
    url?: string;
}
export declare function scoreTargetUrlMatch(target: CDPTargetSummary, targetUrl?: string): number;
export declare function filterMatchingPageTargets(targets: CDPTargetSummary[], targetUrl?: string): CDPTargetSummary[];
