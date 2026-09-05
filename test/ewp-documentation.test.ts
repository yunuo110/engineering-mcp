import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ewpRequestSchema, ewpResultSchema } from '../src/adapters/ewp.ts';

const docsPath = fileURLToPath(new URL('../docs/engineering-worker-protocol.md', import.meta.url));

function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```json\n([\s\S]*?)\n```/g;
  for (const match of markdown.matchAll(regex)) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

describe('EWP public documentation examples', () => {
  it('request and result examples match authoritative runtime schemas', () => {
    const markdown = readFileSync(docsPath, 'utf8').replace(/\r\n/g, '\n');
    const blocks = jsonBlocks(markdown);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const requestExample = JSON.parse(blocks[0]!) as unknown;
    const requestParsed = ewpRequestSchema.safeParse(requestExample);
    expect(requestParsed.success).toBe(true);

    const resultExample = JSON.parse(blocks[1]!) as unknown;
    const resultParsed = ewpResultSchema.safeParse(resultExample);
    expect(resultParsed.success).toBe(true);
  });
});
