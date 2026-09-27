/** Types for the parts of server.mjs that vite.config.ts imports. */
import type { Server } from 'node:http';

export declare const PORT: number;
export declare const ORIGIN: string;
export declare const SAMPLE_RELEASE: string;
export declare function startServer(root: string, port?: number, opts?: { releaseBase?: string }): Promise<Server>;
