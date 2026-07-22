export interface MatchResult {
    x: number;
    targetLeftX: number;
    confidence: number;
    scores: Array<{
        x: number;
        score: number;
    }>;
    method: string;
    edgeX: number;
    gapX: number;
    nccX: number;
    contourX: number;
    pieceBounds: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
}
export declare function templateMatch(backgroundInput: Buffer | string, puzzleInput: Buffer | string): Promise<MatchResult>;
