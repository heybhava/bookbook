// Archive safety. ZIP-based uploads (EPUB, DOCX, XLSX, vault imports) are checked BEFORE any library decompresses them.
// The central directory is read directly (no decompression): entry count, declared sizes and compression ratios are limited. Extraction that this app performs
// itself (vault import) additionally counts the real bytes produced and aborts, so a header that lies cannot defeat the limit.
import { cfg } from './auth/config';

export class ArchiveError extends Error { status = 422; }
export function guardZip(buf: Buffer, label = 'archive'): { entries: number; uncompressed: number } {
  if (buf.length < 22) throw new ArchiveError(`This ${label} is not a valid zip file.`);
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError(`This ${label} is not a valid zip file.`);
  const total = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ArchiveError(`Zip64 archives are not supported (${label}).`);
  if (total > cfg.maxZipEntries) throw new ArchiveError(`This ${label} has too many files (${total}; limit ${cfg.maxZipEntries}).`);
  if (cdOff + cdSize > buf.length) throw new ArchiveError(`This ${label} is corrupt.`);
  let p = cdOff, sum = 0, n = 0;
  while (n < total) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError(`This ${label} is corrupt.`);
    const flags = buf.readUInt16LE(p + 8), comp = buf.readUInt32LE(p + 20), un = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    if (flags & 1) throw new ArchiveError(`This ${label} contains encrypted files, which are not supported.`);
    if (un > 64 * 1048576 && un / Math.max(1, comp) > cfg.maxZipRatio) throw new ArchiveError(`This ${label} looks like a decompression bomb (a file expands ${Math.round(un / Math.max(1, comp))}×).`);
    if (un > 1024 * 1048576) throw new ArchiveError(`A file inside this ${label} is larger than 1 GB.`);
    sum += un; if (sum > cfg.maxZipBytes) throw new ArchiveError(`This ${label} would expand to more than ${Math.round(cfg.maxZipBytes / 1048576)} MB.`);
    p += 46 + nl + el + cl; n++;
  }
  if (buf.length > 0 && sum / buf.length > cfg.maxZipRatio * 4 && sum > 256 * 1048576) throw new ArchiveError(`This ${label} has an extreme overall compression ratio.`);
  return { entries: total, uncompressed: sum };
}
/** Read one zip entry's stream with a hard byte cap (the declared size is not trusted). */
export function readCapped(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => { const chunks: Buffer[] = []; let n = 0; stream.on('data', (c: Buffer) => { n += c.length; if (n > cap) { (stream as any).destroy?.(); reject(new ArchiveError('A file inside the archive expanded beyond its declared size.')); return; } chunks.push(c); }); stream.on('end', () => resolve(Buffer.concat(chunks))); stream.on('error', reject); });
}
