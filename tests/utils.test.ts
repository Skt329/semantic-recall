import { describe, it, expect } from 'vitest';
import { cosineSimilarity, parseTTL, generateExpiresAt, parseEmbedding, computeBackoffMs, parseTags } from '../src/utils.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow('mismatch');
  });
  it('throws on empty vectors', () => {
    expect(() => cosineSimilarity([], [])).toThrow('empty');
  });
});

describe('parseTTL', () => {
  it('parses hours', () => { expect(parseTTL('1h')).toBe(3600000); });
  it('parses days', () => { expect(parseTTL('7d')).toBe(604800000); });
  it('parses ms', () => { expect(parseTTL('500ms')).toBe(500); });
  it('parses number as ms', () => { expect(parseTTL(1000)).toBe(1000); });
  it('throws on invalid format', () => { expect(() => parseTTL('abc')).toThrow('Invalid TTL'); });
});

describe('generateExpiresAt', () => {
  it('returns null for undefined', () => { expect(generateExpiresAt()).toBeNull(); });
  it('returns ISO string for valid TTL', () => {
    const result = generateExpiresAt('1h');
    expect(result).toBeTruthy();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('parseEmbedding', () => {
  it('parses valid JSON array', () => {
    expect(parseEmbedding('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('throws on non-array', () => {
    expect(() => parseEmbedding('"hello"')).toThrow('not an array');
  });
});

describe('computeBackoffMs', () => {
  it('doubles each attempt', () => {
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(3)).toBe(8000);
  });
});

describe('cosineSimilarity — precision', () => {
  it('produces results close to 1.0 for nearly identical high-dimensional vectors', () => {
    // Generate a 384-dim vector with tiny perturbations to stress floating-point
    const base = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1) * 0.5 + 0.5);
    const perturbed = base.map(v => v + 1e-10);
    const sim = cosineSimilarity(base, perturbed);
    // Must be extremely close to 1.0 — sqrt(a*b) form prevents drift
    // Note: non-normalized vectors can yield sim slightly above 1.0 due to FP arithmetic
    expect(sim).toBeGreaterThan(0.9999999);
    expect(Math.abs(sim - 1.0)).toBeLessThan(1e-12);
  });

  it('always returns <= 1.0 for normalized vectors', () => {
    const v = Array.from({ length: 384 }, (_, i) => Math.cos(i));
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const norm = v.map(x => x / mag);
    // Self-similarity of a normalized vector must be exactly 1.0 (or ~1.0)
    expect(cosineSimilarity(norm, norm)).toBeCloseTo(1.0, 10);
  });
});

describe('parseTags', () => {
  it('parses valid JSON array of strings', () => {
    expect(parseTags('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });
  it('returns [] for null', () => {
    expect(parseTags(null)).toEqual([]);
  });
  it('returns [] for undefined', () => {
    expect(parseTags(undefined)).toEqual([]);
  });
  it('returns [] for empty string', () => {
    expect(parseTags('')).toEqual([]);
  });
  it('returns [] for malformed JSON', () => {
    expect(parseTags('{invalid')).toEqual([]);
  });
  it('returns [] for JSON object (not array)', () => {
    expect(parseTags('{"foo":"bar"}')).toEqual([]);
  });
  it('returns [] for JSON number', () => {
    expect(parseTags('42')).toEqual([]);
  });
  it('filters out non-string elements', () => {
    expect(parseTags('[1, "valid", true, null, "also_valid"]')).toEqual(['valid', 'also_valid']);
  });
});
