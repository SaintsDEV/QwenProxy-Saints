import http from 'node:http';
import { SolveJobQueue } from './job-queue.js';
export declare function createApiServer(): {
    server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
    queue: SolveJobQueue;
};
export declare function startApiServer(): void;
