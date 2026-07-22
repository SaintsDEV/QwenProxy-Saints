import { randomUUID } from 'node:crypto';
export class SolveJobQueue {
    runner;
    jobs = new Map();
    browserTails = new Map();
    runningCount = 0;
    waiters = [];
    maxConcurrentJobs;
    retentionMs;
    constructor(runner, options = {}) {
        this.runner = runner;
        this.maxConcurrentJobs = Math.max(1, Math.floor(options.maxConcurrentJobs ?? 2));
        this.retentionMs = Math.max(0, Math.floor(options.retentionMs ?? 60 * 60 * 1000));
    }
    enqueue(request) {
        const now = new Date().toISOString();
        const job = {
            id: `job_${randomUUID()}`,
            status: 'queued',
            request,
            createdAt: now,
            updatedAt: now,
        };
        this.jobs.set(job.id, job);
        const previousTail = this.browserTails.get(request.browserKey) ?? Promise.resolve();
        const currentTail = previousTail
            .catch(() => undefined)
            .then(() => this.run(job.id));
        this.browserTails.set(request.browserKey, currentTail);
        void currentTail.finally(() => {
            if (this.browserTails.get(request.browserKey) === currentTail) {
                this.browserTails.delete(request.browserKey);
            }
        });
        return job;
    }
    get(jobId) {
        return this.jobs.get(jobId);
    }
    stats() {
        const stats = {
            total: this.jobs.size,
            queued: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
            error: 0,
            browsers: {},
        };
        for (const job of this.jobs.values()) {
            stats[job.status]++;
            const browser = stats.browsers[job.request.browserKey] ?? { queued: 0, running: 0 };
            if (job.status === 'queued')
                browser.queued++;
            if (job.status === 'running')
                browser.running++;
            stats.browsers[job.request.browserKey] = browser;
        }
        return stats;
    }
    async run(jobId) {
        const job = this.jobs.get(jobId);
        if (!job)
            return;
        await this.acquireSlot();
        const startedAt = new Date().toISOString();
        job.status = 'running';
        job.startedAt = startedAt;
        job.updatedAt = startedAt;
        try {
            job.result = await this.runner(job);
            job.status = job.result.success ? 'succeeded' : 'failed';
        }
        catch (error) {
            job.status = 'error';
            job.error = {
                message: error instanceof Error ? error.message : String(error),
                code: 'solver_error',
            };
        }
        finally {
            const finishedAt = new Date().toISOString();
            job.finishedAt = finishedAt;
            job.updatedAt = finishedAt;
            this.releaseSlot();
            this.scheduleCleanup(job.id);
        }
    }
    async acquireSlot() {
        if (this.runningCount < this.maxConcurrentJobs) {
            this.runningCount++;
            return;
        }
        await new Promise((resolve) => {
            this.waiters.push(resolve);
        });
        this.runningCount++;
    }
    releaseSlot() {
        this.runningCount = Math.max(0, this.runningCount - 1);
        const next = this.waiters.shift();
        if (next)
            next();
    }
    scheduleCleanup(jobId) {
        if (this.retentionMs === 0)
            return;
        setTimeout(() => {
            const job = this.jobs.get(jobId);
            if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'error')) {
                this.jobs.delete(jobId);
            }
        }, this.retentionMs).unref();
    }
}
//# sourceMappingURL=job-queue.js.map