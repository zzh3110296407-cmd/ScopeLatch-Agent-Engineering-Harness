import crypto from 'node:crypto';
import path from 'node:path';
import { matchesAny, normalizePath, safeReadPartial, truncate, unique } from './common.mjs';
import { filterRepoFiles, textRepoFiles } from './repo.mjs';

export function buildContextPack({ root, taskInfo, files, config }) {
  const filtered = filterRepoFiles(files, config);
  const textFiles = textRepoFiles(files, config);
  const maxBytes = config.context.maxFileBytesToScan;
  const retrievalProfile = resolveRetrievalProfile(taskInfo, config.context.controlPlane);
  const scored = scoreFiles({ root, files: textFiles, taskInfo, maxBytes, config, retrievalProfile });
  const { candidates, duplicates } = deduplicateCandidates(scored, config.context.sourcePriority);
  const profileCandidates = retrievalProfile.id === 'harness-control-plane'
    ? candidates.filter((candidate) => retrievalProfile.matches(candidate.file))
    : candidates;

  const mentioned = taskInfo.fileMentions
    .map((f) => resolveMention(f, filtered, config) || normalizePath(f));

  const agentFiles = filtered.filter((f) => /(^|\/)AGENTS\.md$/i.test(f));
  const docs = pickDocs(filtered, taskInfo.tokens, config, retrievalProfile);

  const nonTestCandidates = profileCandidates
    .filter((c) => !isTestFile(c.file))
    .filter((c) => !c.generated || config.context.sourcePriority?.includeGeneratedInMustRead === true)
    .map((c) => c.file);

  const scoredTestCandidates = profileCandidates
    .filter((c) => isTestFile(c.file))
  const testPool = config.context.sourcePriority?.preferActiveTests !== false
    && scoredTestCandidates.some((candidate) => candidate.active)
    ? scoredTestCandidates.filter((candidate) => candidate.active)
    : scoredTestCandidates;
  const testCandidates = testPool.map((candidate) => candidate.file);

  const mustRead = unique([
    ...mentioned,
    ...agentFiles,
    ...nonTestCandidates
  ]).slice(0, config.context.maxMustReadFiles);

  const relatedFiles = unique(profileCandidates.map((c) => c.file))
    .filter((f) => !mustRead.includes(f))
    .slice(0, config.context.maxRelatedFiles);

  const relatedTests = unique([
    ...testCandidates,
    ...findLikelyTests(filtered, mustRead, config, retrievalProfile)
  ]).slice(0, config.context.maxRelatedTests);

  const context = {
    task: taskInfo.raw,
    intent: taskInfo.intent,
    tokens: taskInfo.tokens,
    riskHints: taskInfo.riskHints,
    mentionedFiles: mentioned,
    mustRead,
    relatedFiles,
    relatedTests,
    docs,
    agentFiles,
    retrieval: {
      profile: retrievalProfile.id,
      activeSourceRoots: config.context.sourcePriority?.activeSourceRoots || [],
      referenceSourceRoots: config.context.sourcePriority?.referenceSourceRoots || [],
      deduplicatedFileCount: duplicates.length,
      duplicateFiles: duplicates
    },
    generatedAt: new Date().toISOString(),
    notes: buildNotes(taskInfo)
  };

  return {
    ...context,
    markdown: renderContextMarkdown({ root, context, candidates, maxBytes })
  };
}

function scoreFiles({ root, files, taskInfo, maxBytes, config, retrievalProfile }) {
  const tokens = taskInfo.tokens.map((t) => t.toLowerCase()).filter(Boolean);
  const out = [];
  for (const file of files) {
    const lowerPath = file.toLowerCase();
    let score = 0;
    const reasons = [];

    for (const token of tokens) {
      if (lowerPath.includes(token)) {
        score += lowerPath.endsWith(`${token}.ts`) || lowerPath.includes(`/${token}/`) ? 9 : 5;
        reasons.push(`path contains ${token}`);
      }
    }

    if (/(^|\/)README(\.|$)/i.test(file)) score += 2;
    if (/(^|\/)AGENTS\.md$/i.test(file)) score += 10;
    if (/docs?\//i.test(file)) score += 1;
    if (taskInfo.intent === 'ui' && /frontend|client|components?|pages?|app\//i.test(file)) score += 3;
    if (taskInfo.intent === 'api' && /api|routes?|controllers?|schema/i.test(file)) score += 4;
    if (taskInfo.intent === 'migration' && /migration|schema|prisma|drizzle|sql/i.test(file)) score += 5;

    const profileWeight = retrievalProfile.weight(file);
    score += profileWeight;
    if (profileWeight > 0) reasons.push(`${retrievalProfile.id} source`);
    if (profileWeight < 0) reasons.push(`outside ${retrievalProfile.id} downgraded`);

    let content = '';
    if (score > 0 || tokens.length <= 8) {
      content = safeReadPartial(root, file, maxBytes);
      const lowerContent = content.toLowerCase();
      if (content) {
        for (const token of tokens) {
          const count = countOccurrences(lowerContent, token);
          if (count > 0) {
            const boost = Math.min(count, 6);
            score += boost;
            if (boost >= 2) reasons.push(`content mentions ${token} x${count}`);
          }
        }
      }
    }

    if (score > 0) {
      const priority = sourcePriorityFor(file, config.context.sourcePriority);
      score += priority.weight;
      if (priority.label) reasons.push(priority.label);
      if (score > 0) {
        out.push({
          file,
          score,
          reasons: unique(reasons).slice(0, 6),
          contentHash: content ? crypto.createHash('sha256').update(content).digest('hex') : null,
          active: priority.active,
          generated: priority.generated,
          historical: priority.historical
        });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function deduplicateCandidates(candidates, priority = {}) {
  if (priority.deduplicateExactContent === false) return { candidates, duplicates: [] };
  const byHash = new Map();
  const kept = [];
  const duplicates = [];
  for (const candidate of candidates) {
    if (!candidate.contentHash) {
      kept.push(candidate);
      continue;
    }
    const canonical = byHash.get(candidate.contentHash);
    if (!canonical) {
      byHash.set(candidate.contentHash, candidate.file);
      kept.push(candidate);
      continue;
    }
    duplicates.push({ file: candidate.file, canonical });
  }
  return { candidates: kept, duplicates };
}

function sourcePriorityFor(file, priority = {}) {
  const active = priority.activeSourceRoots || [];
  const references = priority.referenceSourceRoots || [];
  const historical = priority.historicalPathPatterns || [];
  const generated = priority.generatedPathPatterns || [];
  let weight = 0;
  const labels = [];
  const isActive = matchesAny(file, active);
  const isHistorical = !isActive && matchesAny(file, historical);
  const isGenerated = matchesAny(file, generated);
  if (isActive) {
    weight += Number(priority.activeBonus || 0);
    labels.push('active source');
  } else if (isHistorical) {
    weight += Number(priority.historicalPenalty || 0);
    labels.push('historical source downgraded');
  } else if (matchesAny(file, references)) {
    weight += Number(priority.referenceBonus || 0);
    labels.push('reference source');
  }
  if (isGenerated) {
    weight += Number(priority.generatedPenalty || 0);
    labels.push('generated artifact downgraded');
  }
  return { weight, label: labels.join('; '), active: isActive, generated: isGenerated, historical: isHistorical };
}

function countOccurrences(content, token) {
  if (!token || token.length < 2) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(token, pos)) !== -1 && count < 50) {
    count += 1;
    pos += token.length;
  }
  return count;
}

function resolveMention(mention, files, config) {
  const m = normalizePath(mention);
  if (files.includes(m)) return m;
  const cleaned = m.replace(/^.*?\//, '');
  const matches = files.filter((f) => f.endsWith(m) || f.endsWith(cleaned));
  return matches.sort((a, b) => sourcePriorityFor(b, config.context.sourcePriority).weight - sourcePriorityFor(a, config.context.sourcePriority).weight || a.localeCompare(b))[0] || null;
}

function isTestFile(file) {
  return /(\.test\.|\.spec\.|__tests__|\/tests?\/|\/e2e\/)/i.test(file);
}

function pickDocs(files, tokens, config, retrievalProfile) {
  const docs = files
    .filter((f) => /(^|\/)(README|AGENTS|CHANGELOG|CONTRIBUTING|ARCHITECTURE|docs?\/)/i.test(f))
    .filter((f) => retrievalProfile.id !== 'harness-control-plane' || retrievalProfile.matches(f));
  return docs
    .map((f) => ({ f, score: tokens.reduce((s, t) => s + (f.toLowerCase().includes(t) ? 3 : 0), 0) + (/AGENTS\.md$/i.test(f) ? 10 : 0) + (/README/i.test(f) ? 2 : 0) + sourcePriorityFor(f, config.context.sourcePriority).weight }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f))
    .slice(0, 12)
    .map((x) => x.f);
}

function findLikelyTests(files, targets, config, retrievalProfile) {
  const targetBases = targets
    .map((f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase())
    .filter((base) => base.length > 7);
  const matches = files.filter((f) => {
    if (!isTestFile(f)) return false;
    if (retrievalProfile.id === 'harness-control-plane' && !retrievalProfile.matches(f)) return false;
    const lower = f.toLowerCase();
    return targetBases.some((b) => lower.includes(b));
  });
  if (config.context.sourcePriority?.preferActiveTests === false) return matches;
  const activeMatches = matches.filter((file) => sourcePriorityFor(file, config.context.sourcePriority).active);
  return activeMatches.length ? activeMatches : matches;
}

function resolveRetrievalProfile(taskInfo, controlPlane = {}) {
  const taskTokens = new Set((taskInfo.tokens || []).map((token) => String(token).toLowerCase()));
  const activationTokens = controlPlane.taskTokens || ['harness'];
  const active = activationTokens.some((token) => taskTokens.has(String(token).toLowerCase()) && String(token).toLowerCase() === 'harness');
  const patterns = controlPlane.pathPatterns || [
    'harness/**',
    '.harness/**',
    '.codex/hooks/**',
    '.github/workflows/**',
    'AGENTS.md'
  ];
  const matches = (file) => matchesAny(file, patterns);
  if (!active) {
    const controlPlanePenalty = Math.min(-60, Number(controlPlane.outsidePenalty ?? -120));
    return {
      id: 'project-source',
      matches: (file) => !matches(file),
      weight: (file) => matches(file) ? controlPlanePenalty : 0
    };
  }
  const activeBonus = Number(controlPlane.activeBonus ?? 120);
  const outsidePenalty = Number(controlPlane.outsidePenalty ?? -120);
  return {
    id: 'harness-control-plane',
    matches,
    weight: (file) => matches(file) ? activeBonus : outsidePenalty
  };
}

function buildNotes(taskInfo) {
  const notes = [];
  if (taskInfo.riskHints.includes('public-api-change')) notes.push('Task likely touches public API/schema; require contract/client synchronization checks.');
  if (taskInfo.riskHints.includes('database-migration')) notes.push('Task likely touches DB schema/migration; require migration, fixture, and integration checks.');
  if (taskInfo.riskHints.includes('auth-change')) notes.push('Task likely touches auth/permission; require allowed and denied path coverage.');
  if (taskInfo.riskHints.includes('payment-change')) notes.push('Task likely touches payment/refund/billing; require idempotency and integration checks where available.');
  return notes;
}

function renderContextMarkdown({ root, context, candidates, maxBytes }) {
  const topReasons = new Map(candidates.map((c) => [c.file, c.reasons]));
  const lines = [];
  lines.push(`# Context Pack`);
  lines.push('');
  lines.push(`Generated: ${context.generatedAt}`);
  lines.push(`Intent: ${context.intent}`);
  lines.push('');
  lines.push(`## Task`);
  lines.push('');
  lines.push(context.task);
  lines.push('');
  lines.push(`## Search Terms`);
  lines.push('');
  lines.push(context.tokens.length ? context.tokens.map((t) => `\`${t}\``).join(', ') : '_No extracted terms._');
  lines.push('');
  lines.push(`## Must Read Files`);
  lines.push('');
  for (const f of context.mustRead) {
    const reasons = topReasons.get(f) || [];
    lines.push(`- ${f}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`);
  }
  if (!context.mustRead.length) lines.push('- _No strong must-read files found. Codex should inspect repo structure before editing._');
  lines.push('');
  lines.push(`## Related Files`);
  lines.push('');
  for (const f of context.relatedFiles) lines.push(`- ${f}`);
  if (!context.relatedFiles.length) lines.push('- _None found._');
  lines.push('');
  lines.push(`## Related Tests`);
  lines.push('');
  for (const f of context.relatedTests) lines.push(`- ${f}`);
  if (!context.relatedTests.length) lines.push('- _No obvious related tests found. Codex should add or identify appropriate tests._');
  lines.push('');
  lines.push(`## Docs and Agent Instructions`);
  lines.push('');
  for (const f of context.docs) lines.push(`- ${f}`);
  if (!context.docs.length) lines.push('- _No docs detected._');
  lines.push('');
  lines.push(`## Notes`);
  lines.push('');
  for (const note of context.notes) lines.push(`- ${note}`);
  if (!context.notes.length) lines.push('- Keep scope narrow and update tests for behavior changes.');
  lines.push('');
  lines.push(`## File Excerpts`);
  lines.push('');
  const excerptFiles = unique([...context.agentFiles, ...context.mustRead]).slice(0, 12);
  for (const f of excerptFiles) {
    const body = safeReadPartial(root, f, maxBytes);
    if (!body) continue;
    lines.push(`### ${f}`);
    lines.push('');
    lines.push('```');
    lines.push(truncate(body, 3000));
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
