/** Inspects only the bounded VSIX package manifest before VS Code chooses its installation server. */
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const MAX_MANIFEST = 64 * 1024;
export async function validateUpdatePackage(path: string, version: string): Promise<void> {
  const file = await open(path, 'r');
  const read = async (position: number, size: number) => {
    const buffer = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      const result = await file.read(buffer, offset, size - offset, position + offset);
      if (!result.bytesRead) throw new Error('Truncated update package'); offset += result.bytesRead;
    }
    return buffer;
  };
  try {
    const size = (await file.stat()).size; const tailSize = Math.min(size, 65557);
    const tail = await read(size - tailSize, tailSize); let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0
      || tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)) throw new Error('Unsupported update archive');
    const entries = tail.readUInt16LE(end + 10); const directorySize = tail.readUInt32LE(end + 12); const directoryOffset = tail.readUInt32LE(end + 16);
    if (entries > 20000 || directorySize > 8 * 1024 * 1024 || directoryOffset + directorySize > size - tailSize + end) throw new Error('Update archive directory exceeds bounds');
    const directory = await read(directoryOffset, directorySize); let offset = 0;
    const manifests = new Map<string, Buffer>(); const names = new Set<string>(); let expanded = 0;
    for (let index = 0; index < entries; index++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid update archive directory');
      const nameSize = directory.readUInt16LE(offset + 28); const extra = directory.readUInt16LE(offset + 30); const comment = directory.readUInt16LE(offset + 32);
      const next = offset + 46 + nameSize + extra + comment;
      if (next > directory.length) throw new Error('Truncated update archive directory');
      const name = directory.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
      const normalized = name.toLocaleLowerCase('en-US');
      const parts = name.replace(/\/$/, '').split('/');
      const flags = directory.readUInt16LE(offset + 8); const method = directory.readUInt16LE(offset + 10);
      const compressed = directory.readUInt32LE(offset + 20); const uncompressed = directory.readUInt32LE(offset + 24);
      const mode = directory.readUInt32LE(offset + 38) >>> 16;
      const localOffset = directory.readUInt32LE(offset + 42);
      expanded += uncompressed;
      if (!name || name.includes('\\') || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))
        || names.has(normalized) || (flags & 1) || ![0, 8].includes(method) || (mode & 0o170000) === 0o120000
        || expanded > 2 * 1024 * 1024 * 1024 || compressed > size || localOffset + 30 > directoryOffset) {
        throw new Error('Unsafe or oversized update archive entry');
      }
      names.add(normalized);
      const localHeader = await read(localOffset, 30);
      if (localHeader.readUInt32LE(0) !== 0x04034b50 || localHeader.readUInt16LE(8) !== method
        || localHeader.readUInt16LE(6) !== flags) throw new Error('Inconsistent update ZIP entry');
      const localNameSize = localHeader.readUInt16LE(26); const localExtra = localHeader.readUInt16LE(28);
      const contentOffset = localOffset + 30 + localNameSize + localExtra;
      if (contentOffset + compressed > directoryOffset
        || (await read(localOffset + 30, localNameSize)).toString('utf8') !== name) throw new Error('ZIP entry data exceeds bounds');
      if (name === 'extension/package.json' || name === 'extension.vsixmanifest') {
        if (manifests.has(name)) throw new Error('Duplicate update package manifest');
        if (compressed > MAX_MANIFEST || uncompressed > MAX_MANIFEST) throw new Error('Unsupported update package manifest');
        const bytes = await read(contentOffset, compressed);
        const decoded = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: MAX_MANIFEST });
        if (decoded.length !== uncompressed) throw new Error('Manifest ZIP size mismatch');
        manifests.set(name, decoded);
      }
      offset = next;
    }
    const found = manifests.get('extension/package.json'); const vsix = manifests.get('extension.vsixmanifest');
    if (!found || !vsix || offset !== directory.length) throw new Error('Update package manifest is missing');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(vsix);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported VSIX manifest');
    if (XMLValidator.validate(xml, { allowBooleanAttributes: false }) !== true) throw new Error('Invalid VSIX XML manifest');
    const document = new XMLParser({ ignoreAttributes: false, processEntities: false,
      parseAttributeValue: false, parseTagValue: false }).parse(xml);
    const identity = document?.PackageManifest?.Metadata?.Identity;
    if (typeof identity !== 'object' || identity === null || Array.isArray(identity)
      || identity['@_Id'] !== 'dsh-companion-vscode' || identity['@_Publisher'] !== 'dsh-companion'
      || identity['@_Version'] !== version || identity['@_TargetPlatform'] !== 'linux-x64') throw new Error('VSIX target platform mismatch');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(found));
    if (!manifest || manifest.name !== 'dsh-companion-vscode' || manifest.publisher !== 'dsh-companion'
      || manifest.version !== version || !Array.isArray(manifest.extensionKind)
      || manifest.extensionKind.length !== 1 || manifest.extensionKind[0] !== 'workspace'
      || manifest.contributes?.localizations !== undefined || manifest.extensionPack !== undefined) throw new Error('Update package identity or installation target mismatch');
  } finally { await file.close(); }
}
