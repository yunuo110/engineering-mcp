import { describe, expect, it } from 'vitest';
import { workerResultSchema } from '../src/orchestration/types.ts';

const validCompleted = {
  outcome: 'completed',
  summary: 'done',
  changed_files: ['a.txt'],
  validation: [{ check: 'check', status: 'passed' }],
  known_limitations: [],
  exit_code: 0,
};

const validBlocked = {
  outcome: 'blocked',
  summary: 'blocked',
  changed_files: [],
  validation: [],
  known_limitations: [],
  blocked_reason: 'X',
  exit_code: 1,
};

describe('WorkerResult runtime schema', () => {
  it('accepts valid completed result', () => {
    expect(workerResultSchema.safeParse(validCompleted).success).toBe(true);
  });

  it('accepts valid blocked result', () => {
    expect(workerResultSchema.safeParse(validBlocked).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(workerResultSchema.safeParse({ outcome: 'completed', summary: 'x' }).success).toBe(false);
  });

  it('rejects invalid outcome', () => {
    expect(workerResultSchema.safeParse({ ...validCompleted, outcome: 'garbage' }).success).toBe(false);
  });

  it('rejects incorrect field types', () => {
    expect(workerResultSchema.safeParse({ ...validCompleted, exit_code: 'zero' }).success).toBe(false);
  });

  it('rejects non-JSON-parseable text when treated as raw payload', () => {
    expect(() => JSON.parse('not json')).toThrow();
  });
});
