import { closeSync, constants, fstatSync, readSync } from 'node:fs';

/** Pure validation of the existing four-field bootstrap identity frame. */
export function validateIdentityFrame(frame: Buffer): void {
  if (frame.length < 16 || frame.length > 2576) throw new Error('IDENTITY_FRAME_REFUSED');
  let offset = 0;
  for (let index = 0; index < 4; index++) {
    if (offset + 4 > frame.length) throw new Error('IDENTITY_FRAME_REFUSED');
    const length = frame.readUInt32LE(offset); offset += 4;
    const maximum = index % 2 === 0 ? 256 : 1024;
    if (length < 1 || length > maximum || offset + length > frame.length)
      throw new Error('IDENTITY_FRAME_REFUSED');
    if (index % 2 === 0) {
      let name: string;
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(offset, offset + length)); }
      catch { throw new Error('IDENTITY_FRAME_REFUSED'); }
      if (name.length === 0 || /[\\/@\0]/u.test(name)) throw new Error('IDENTITY_FRAME_REFUSED');
    } else {
      if (length < 4 || length % 2 !== 0 || frame[offset + length - 2] !== 0
        || frame[offset + length - 1] !== 0) throw new Error('IDENTITY_FRAME_REFUSED');
      for (let position = offset; position < offset + length - 2; position += 2) {
        const code = frame.readUInt16LE(position);
        if (code === 0) throw new Error('IDENTITY_FRAME_REFUSED');
        if (code >= 0xd800 && code <= 0xdbff) {
          position += 2;
          if (position >= offset + length - 2) throw new Error('IDENTITY_FRAME_REFUSED');
          const low = frame.readUInt16LE(position);
          if (low < 0xdc00 || low > 0xdfff) throw new Error('IDENTITY_FRAME_REFUSED');
        } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('IDENTITY_FRAME_REFUSED');
      }
    }
    offset += length;
  }
  if (offset !== frame.length) throw new Error('IDENTITY_FRAME_REFUSED');
}

/** DEVELOPMENT ONLY. fd 3 is a dedicated inherited pipe, never MCP stdin/file/env. */
export function consumeDevelopmentIdentityChannel(fd: number): Buffer {
  const parts: Buffer[] = [];
  let frame: Buffer | undefined;
  const read = (length: number): Buffer => {
    const value = Buffer.alloc(length);
    parts.push(value);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, value, offset, length - offset, null);
      if (!count) throw new Error('DEVELOPMENT_IDENTITY_REFUSED:truncated frame');
      offset += count;
    }
    return value;
  };
  try {
    if (fd !== 3) throw new Error('DEVELOPMENT_IDENTITY_REFUSED:dedicated descriptor required');
    const stat = fstatSync(fd);
    // Node deliberately returns false from Stats.isFIFO/isSocket on Windows,
    // even when libuv reports an inherited pipe's S_IFIFO mode.
    const kind = stat.mode & constants.S_IFMT;
    if (kind !== constants.S_IFIFO && !(process.platform !== 'win32' && kind === constants.S_IFSOCK)) {
      throw new Error('DEVELOPMENT_IDENTITY_REFUSED:pipe required');
    }
    for (const maximum of [256, 1024, 256, 1024]) {
      const header = read(4);
      const length = header.readUInt32LE();
      if (length < 1 || length > maximum) throw new Error('DEVELOPMENT_IDENTITY_REFUSED:frame bound');
      read(length);
    }
    const tail = Buffer.alloc(1); parts.push(tail);
    if (readSync(fd, tail, 0, 1, null) !== 0) throw new Error('DEVELOPMENT_IDENTITY_REFUSED:trailing frame');
    parts.pop(); tail.fill(0);
    frame = Buffer.concat(parts);
    validateIdentityFrame(frame);
    return frame;
  } catch (error) {
    frame?.fill(0);
    throw error;
  } finally {
    for (const part of parts) part.fill(0);
    if (fd === 3) closeSync(fd);
  }
}

export function oneTimeIdentityFrame(frame: Buffer): { take: () => Buffer | undefined; dispose: () => void } {
  let available: Buffer | undefined = frame;
  return {
    take() { const current = available; available = undefined; return current; },
    dispose() { available?.fill(0); available = undefined; },
  };
}
