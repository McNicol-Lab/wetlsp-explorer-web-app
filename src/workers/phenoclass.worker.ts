/// <reference lib="webworker" />
/**
 * Phenology-classification worker: reads the site's annual NetCDFs at full
 * resolution from OPFS, runs the pipeline, and writes each run to its own
 * OPFS directory. Nothing here touches the display pipeline's downsampled
 * rasters.
 */
import { serve, type HandlerContext } from '@/lib/rpc';
import { readSiteFile } from '@/lib/opfs';
import { decodeYear, sha256Hex, withH5File } from '@/lib/phenoclass/h5source';
import {
  inspectYears,
  runDiagnostics,
  trainAndClassify,
  type DiagnosticsOptions,
  type Inspection,
  type LoadedYear,
  type PipelineContext,
  type YearSource,
} from '@/lib/phenoclass/pipeline';
import { deleteIncompleteRuns, deleteRun, writeRunFile } from '@/lib/phenoclass/storage';
import { newId, validateModel, type DiagnosticsResult, type PhenoclassModel, type RunManifest } from '@/lib/phenoclass/model';

export interface YearFile {
  year: number;
  path: string;
  size: number;
  importedAt: number;
}

export interface TrainRequest {
  k: number;
  sampleSize: number;
  diagnostics: DiagnosticsResult | null;
  /** Raw model JSON to apply instead of training; validated here before use. */
  model?: unknown;
}

/** SHA-256 per file, keyed by path + size + import time, so pass B does not hash again. */
const hashes = new Map<string, string>();

function sources(siteId: string, files: YearFile[], ctx: HandlerContext): YearSource[] {
  return files.map((f) => ({
    year: f.year,
    load: async (): Promise<LoadedYear> => {
      ctx.throwIfCancelled();
      const blob = await readSiteFile(siteId, f.path);
      if (blob.size !== f.size) {
        throw new Error(`${f.path} is ${blob.size} bytes on disk but ${f.size} in the site manifest; re-import the site.`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const key = `${siteId}::${f.path}::${f.size}::${f.importedAt}`;
      let sha = hashes.get(key);
      if (!sha) {
        sha = await sha256Hex(bytes);
        hashes.set(key, sha);
      }
      const decoded = await withH5File(bytes, (file) => decodeYear(file, f.year));
      return {
        input: decoded.input,
        grid: decoded.grid,
        fingerprint: { year: f.year, path: f.path, size: f.size, sha256: sha, importedAt: f.importedAt },
      };
    },
  }));
}

function pipelineCtx(ctx: HandlerContext): PipelineContext {
  return {
    progress: (p) => ctx.progress(p),
    // Yielding lets the cancel message in; without it a long fit could not be stopped.
    checkpoint: async () => {
      await new Promise((r) => setTimeout(r, 0));
      ctx.throwIfCancelled();
    },
  };
}

const handlers = {
  async inspect(ctx: HandlerContext, siteId: string, files: YearFile[]): Promise<Inspection> {
    return inspectYears(sources(siteId, files, ctx), pipelineCtx(ctx));
  },

  async diagnose(ctx: HandlerContext, siteId: string, files: YearFile[], opts: DiagnosticsOptions): Promise<DiagnosticsResult> {
    return runDiagnostics(sources(siteId, files, ctx), opts, pipelineCtx(ctx));
  },

  async train(ctx: HandlerContext, siteId: string, files: YearFile[], req: TrainRequest): Promise<RunManifest> {
    await deleteIncompleteRuns(siteId);
    const model: PhenoclassModel | undefined = req.model ? validateModel(req.model, siteId) : undefined;
    const runId = newId('run');
    try {
      return await trainAndClassify(
        sources(siteId, files, ctx),
        { siteId, k: model ? model.kmeans.k : req.k, sampleSize: req.sampleSize, diagnostics: req.diagnostics, model, runId },
        pipelineCtx(ctx),
        { write: (name, data) => writeRunFile(siteId, runId, name, data) },
      );
    } catch (err) {
      // A failed or cancelled run leaves nothing behind; saved runs are untouched.
      await deleteRun(siteId, runId);
      throw err;
    }
  },
};

serve(handlers as unknown as Record<string, (ctx: HandlerContext, ...args: never[]) => unknown>);
