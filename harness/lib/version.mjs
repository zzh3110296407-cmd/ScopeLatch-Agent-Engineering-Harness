import path from 'node:path';
import { readJson } from './common.mjs';

export function readHarnessVersion(root) {
  const metadata = readJson(path.join(root, 'harness', 'version.json'), null);
  if (!metadata || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error('Harness version metadata is missing or invalid.');
  }
  return metadata;
}
