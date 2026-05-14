import { describe, it, expect } from 'vitest';
import { cosineSimilarity, parseTTL, generateExpiresAt, parseEmbedding, computeBackoffMs } from '../src/utils.js';

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
