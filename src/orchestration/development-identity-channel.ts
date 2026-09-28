import { closeSync, constants, fstatSync, readSync } from 'node:fs';

/** DEVELOPMENT ONLY. fd 3 is a dedicated inherited pipe, never MCP stdin/file/env. */
export function consumeDevelopmentIdentityChannel(fd: number): Buffer {
  const parts: Buffer[] = [];
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
    return Buffer.concat(parts);
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
