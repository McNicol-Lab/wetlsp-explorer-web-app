import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trainAndClassify, type YearSource } from './pipeline';
import { resolveGrid } from './grid';
import { bundleEntries, coverJson } from './exports';
import { REQUIRED_VARIABLES, STATUS } from './constants';
import type { VariableData } from './features';

const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__/reference-small.json'), 'utf8')).cases[0] as {
  height: number; width: number; inputs: Record<string, number[]>;
};

describe('saved classification and class-cover exports', () => {
  it('keeps full-resolution cover, exclusions, model identity and consensus in its JSON and ZIP', async () => {
    const vars = Object.fromEntries(REQUIRED_VARIABLES.map((name) => [name, {
      values: Int16Array.from(fixture.inputs[name]), fill: 32767, validMin: null, validMax: null,
      scale: name.startsWith('EVIarea') ? 0.01 : name.startsWith('EVI') ? 0.0001 : 1, offset: 0,
    } satisfies VariableData]));
    const grid = resolveGrid({ width: fixture.width, height: fixture.height, x: null, y: null,
      geoTransform: [500000, 3, 0, 4000000, 0, -3], rowsReversed: false,
      crsWkt: 'PROJCRS["WGS 84 / UTM zone 10N",LENGTHUNIT["metre",1],ID["EPSG",32610]]' });
    const years = [2021, 2022, 2023, 2024];
    const sources: YearSource[] = years.map((year) => ({ year, load: async () => ({
      input: { ...fixture, year, vars }, grid,
      fingerprint: { year, path: `${year}.nc`, size: 100, sha256: 'fixture', importedAt: 1 },
    }) }));
    const files = new Map<string, Uint8Array | Float32Array | string>();
    const run = await trainAndClassify(sources, { siteId: 'test', k: 3, nInit: 2, sampleSize: 0 },
      { progress: () => {}, checkpoint: async () => {} }, { write: async (name, data) => { files.set(name, data); } });
    const cover = JSON.parse(coverJson(run));
    expect(cover).toMatchObject({ schema: 'wetlsp-class-cover', siteId: 'test', modelId: run.model.modelId, years, k: 3 });
    expect(cover.annual).toHaveLength(4);
    for (const a of cover.annual) {
      expect(a.rows.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(a.classifiedCells);
      expect(a.statusCounts[STATUS.QA_REJECTED]).toBeGreaterThan(0);
      expect(a.rows.reduce((sum: number, row: { pctClassified: number }) => sum + row.pctClassified, 0)).toBeCloseTo(100);
    }
    const c = cover.consensus;
    expect(c.policy).toMatchObject({ isFourYear: true, minValidYears: 3 });
    expect(c.classifiedCells + c.ambiguousCells + c.insufficientCells + c.noValidYearCells).toBe(c.footprintCells);
    const entries = bundleEntries(run, {
      labels: Object.fromEntries(years.map((y) => [y, files.get(`labels-${y}.u8`) as Uint8Array])),
      consensus: { cls: files.get('consensus-class.u8') as Uint8Array,
        validYears: files.get('consensus-valid-years.u8') as Uint8Array,
        agreement: files.get('consensus-agreement.f32') as Float32Array },
    });
    expect(entries.filter((e) => /classes_\d+\.tif$/.test(e.path))).toHaveLength(4);
    const exported = entries.find((e) => e.path.endsWith('/class_cover.json'))!;
    expect(JSON.parse(exported.data as string)).toEqual(cover);
    expect([...files.keys()].at(-1)).toBe('manifest.json');
    expect(JSON.parse(files.get('manifest.json') as string).annual.map((a: { cover: unknown }) => a.cover)).toEqual(cover.annual);
  });
});
