import { normalizePath, unique } from './common.mjs';

export function allowedScopeFiles(impactReport = {}) {
  if (!Array.isArray(impactReport.writeTargets)) {
    const syncFiles = (impactReport.requiredSynchronizations || []).flatMap((sync) => sync.trigger?.files || []);
    return new Set(unique([
      ...(impactReport.directTargets || []),
      ...(impactReport.reverseDependents || []),
      ...(impactReport.impactedTests || []),
      ...(impactReport.changedFiles || []),
      ...syncFiles
    ]).map(normalizePath));
  }
  return new Set(unique([
    ...(impactReport.writeTargets || []),
    ...(impactReport.changedFiles || [])
  ]).map(normalizePath));
}

export function allowedScopePatterns(impactReport = {}) {
  return unique((impactReport.writePatterns || []).map(normalizePath));
}
