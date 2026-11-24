import { connect } from 'node:net';
import { env } from '../../config/env.js';

export interface ScanResult {
  status: 'CLEAN' | 'INFECTED';
  signature?: string;
  engine: string;
  version: string;
}
export interface MalwareScanner {
  /** Throws when the scanner is unreachable; callers keep the file quarantined. */
  scan(content: Buffer): Promise<ScanResult>;
}

export class ScannerUnavailableError extends Error {
  constructor() {
    super('Malware scanner is unavailable');
    this.name = 'ScannerUnavailableError';
  }
}

function clamdCommand(
  host: string,
  port: number,
  payload: (socket: ReturnType<typeof connect>) => void,
) {
  return new Promise<string>((resolvePromise, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    socket.setTimeout(60_000, () => socket.destroy(new ScannerUnavailableError()));
    socket.on('connect', () => payload(socket));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () =>
      resolvePromise(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()),
    );
    socket.on('error', () => reject(new ScannerUnavailableError()));
  });
}

/** ClamAV clamd INSTREAM client. The scanner host should be network-restricted. */
export class ClamdScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}
  async scan(content: Buffer): Promise<ScanResult> {
    const version = await clamdCommand(this.host, this.port, (socket) => socket.end('zVERSION\0'));
    const reply = await clamdCommand(this.host, this.port, (socket) => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < content.length; offset += 64 * 1024) {
        const chunk = content.subarray(offset, offset + 64 * 1024);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    if (reply.endsWith('OK'))
      return { status: 'CLEAN', engine: 'clamav', version: version.slice(0, 100) };
    const found = /stream: (.+) FOUND$/.exec(reply);
    if (found)
      return {
        status: 'INFECTED',
        signature: found[1]!.slice(0, 200),
        engine: 'clamav',
        version: version.slice(0, 100),
      };
    throw new ScannerUnavailableError();
  }
}

let scanner: MalwareScanner | undefined = env.CLAMAV_HOST
  ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
  : undefined;
export const malwareScanner = () => scanner;
/** Test and alternative-engine seam. */
export function setMalwareScanner(next: MalwareScanner | undefined): void {
  scanner = next;
}

/** Content sniffing: the declared type must match the file's own signature. */
export function sniffMimeType(content: Buffer): string | undefined {
  if (content.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  if (
    content.subarray(0, 4).toString('latin1') === 'RIFF' &&
    content.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
