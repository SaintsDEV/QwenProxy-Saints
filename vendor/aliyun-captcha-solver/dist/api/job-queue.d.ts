import type { ApiSolveResult, NormalizedSolveRequest, QueueStats, SolveJob } from './types.js';
type JobRunner = (job: SolveJob) => Promise<ApiSolveResult>;
interface SolveJobQueueOptions {
    maxConcurrentJobs?: number;
    retentionMs?: number;
}
export declare class SolveJobQueue {
    private readonly runner;
    private readonly jobs;
    private readonly browserTails;
    private runningCount;
    private readonly waiters;
    private readonly maxConcurrentJobs;
    private readonly retentionMs;
    constructor(runner: JobRunner, options?: SolveJobQueueOptions);
    enqueue(request: NormalizedSolveRequest): SolveJob;
    get(jobId: string): SolveJob | undefined;
    stats(): QueueStats;
    private run;
    private acquireSlot;
    private releaseSlot;
    private scheduleCleanup;
}
export {};
