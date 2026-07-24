import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  PipelineArtifact,
  PipelineRuntimeSnapshot,
} from './PipelineV3Types';

const SPECIFICATION_TYPE = 'acp.specification/v1';
const TICKET_GRAPH_TYPE = 'acp.ticket-graph/v1';

export interface PipelineArtifactPublication {
  featureSlug: string;
  directory: string;
  files: string[];
  ticketCount: number;
}

export type PipelineArtifactPublisher = (
  workspaceCwd: string,
  snapshot: PipelineRuntimeSnapshot,
) => PipelineArtifactPublication | null;

interface TicketDocument {
  id?: string;
  title: string;
  content: string;
}

interface TicketStart {
  lineIndex: number;
  id?: string;
  title: string;
}

export const publishPipelineArtifacts: PipelineArtifactPublisher = (
  workspaceCwd,
  snapshot,
) => {
  if (!fs.existsSync(workspaceCwd)) {
    return null;
  }

  const specification = findArtifact(
    snapshot,
    SPECIFICATION_TYPE,
    ['specification', 'spec'],
  );
  const ticketGraph = findArtifact(
    snapshot,
    TICKET_GRAPH_TYPE,
    ['tickets', 'ticketGraph'],
  );
  if (!specification && !ticketGraph) {
    return null;
  }

  const featureSlug = resolveFeatureSlug(snapshot, specification);
  const scratchRoot = path.resolve(workspaceCwd, '.scratch');
  const directoryPath = path.resolve(scratchRoot, featureSlug);
  assertChildPath(scratchRoot, directoryPath);
  fs.mkdirSync(directoryPath, { recursive: true });

  const writtenFiles: string[] = [];
  if (specification) {
    const specPath = path.join(directoryPath, 'spec.md');
    writeMarkdown(specPath, renderSpecification(specification.value));
    writtenFiles.push(toWorkspacePath(workspaceCwd, specPath));
  }

  let ticketCount = 0;
  if (ticketGraph) {
    const issuesDirectory = path.join(directoryPath, 'issues');
    fs.mkdirSync(issuesDirectory, { recursive: true });

    const rendered = renderTicketGraph(ticketGraph.value);
    const readmePath = path.join(issuesDirectory, 'README.md');
    writeMarkdown(readmePath, rendered.combined);
    writtenFiles.push(toWorkspacePath(workspaceCwd, readmePath));

    clearGeneratedTicketFiles(issuesDirectory);
    rendered.tickets.forEach((ticket, index) => {
      const issueNumber = String(index + 1).padStart(2, '0');
      const titleSlug = slugify(ticket.title) || `ticket-${issueNumber}`;
      const issuePath = path.join(
        issuesDirectory,
        `${issueNumber}-${titleSlug}.md`,
      );
      writeMarkdown(issuePath, normalizeTicketDocument(ticket, issueNumber));
      writtenFiles.push(toWorkspacePath(workspaceCwd, issuePath));
    });
    ticketCount = rendered.tickets.length;
  }

  return {
    featureSlug,
    directory: toWorkspacePath(workspaceCwd, directoryPath),
    files: writtenFiles,
    ticketCount,
  };
};

function findArtifact(
  snapshot: PipelineRuntimeSnapshot,
  type: string,
  preferredNames: string[],
): PipelineArtifact | undefined {
  const matches = Object.values(snapshot.artifacts)
    .filter(artifact => artifact.type === type);
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (preferredNames.includes(matches[index].name)) {
      return matches[index];
    }
  }
  return matches[matches.length - 1];
}

function resolveFeatureSlug(
  snapshot: PipelineRuntimeSnapshot,
  specification: PipelineArtifact | undefined,
): string {
  const title = specification
    ? extractSpecificationTitle(specification.value)
    : '';
  const userPrompt = typeof snapshot.inputVariables?.userPrompt === 'string'
    ? snapshot.inputVariables.userPrompt
    : '';
  const candidates = [
    stripSpecificationPrefix(title),
    userPrompt,
    snapshot.pipelineId,
    snapshot.runId,
  ];
  for (const candidate of candidates) {
    const slug = slugify(candidate);
    if (slug) {
      return slug;
    }
  }
  return 'pipeline-artifacts';
}

function extractSpecificationTitle(value: unknown): string {
  if (typeof value === 'string') {
    const heading = value.match(/^\s*#\s+(.+?)\s*$/m);
    if (heading) {
      return heading[1];
    }
    const firstLine = value
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    return firstLine && firstLine.length <= 120 ? firstLine : '';
  }
  if (isRecord(value) && typeof value.title === 'string') {
    return value.title;
  }
  return '';
}

function stripSpecificationPrefix(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(
      /^(?:sp[eé]cification|specification|spec|prd)\b\s*(?:(?:—|–|:|-)\s*)?/i,
      '',
    )
    .trim();
}

function renderSpecification(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    const title = readString(value.title);
    const summary = readString(value.summary);
    const requirements = readStringArray(value.requirements);
    const nonGoals = readStringArray(value.nonGoals);
    if (title || summary || requirements.length > 0 || nonGoals.length > 0) {
      const sections = [
        title ? `# ${title}` : '# Specification',
        summary ? `## Summary\n\n${summary}` : '',
        renderBulletSection('Requirements', requirements),
        renderBulletSection('Out of Scope', nonGoals),
      ].filter(Boolean);
      return sections.join('\n\n');
    }
  }
  return `# Specification\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderTicketGraph(value: unknown): {
  combined: string;
  tickets: TicketDocument[];
} {
  if (typeof value === 'string') {
    return {
      combined: value,
      tickets: parseMarkdownTickets(value),
    };
  }

  if (isRecord(value) && Array.isArray(value.tickets)) {
    const tickets = value.tickets
      .map(renderStructuredTicket)
      .filter((ticket): ticket is TicketDocument => ticket !== null);
    return {
      combined: [
        '# Ordered Tracer-Bullet Task Plan',
        ...tickets.map((ticket, index) =>
          normalizeTicketDocument(ticket, String(index + 1).padStart(2, '0'))),
      ].join('\n\n'),
      tickets,
    };
  }

  return {
    combined: `# Ordered Tracer-Bullet Task Plan\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
    tickets: [],
  };
}

function renderStructuredTicket(value: unknown): TicketDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const title = readString(value.title) || id;
  if (!title) {
    return null;
  }
  const scope = readStringArray(value.scope);
  const blockers = readStringArray(value.needs);
  const validation = readStringArray(value.validation);
  const agent = readString(value.agent);
  const body = [
    scope.length > 0
      ? `**What to build:** ${scope.join('; ')}`
      : '**What to build:** Complete the tracer-bullet behavior described by this ticket.',
    `**Blocked by:** ${blockers.length > 0 ? blockers.join(', ') : 'None — can start immediately'}`,
    '**Status:** ready-for-agent',
    validation.length > 0
      ? `## Validation\n\n${validation.map(item => `- [ ] ${item}`).join('\n')}`
      : '',
    agent ? `## Suggested agent\n\n${agent}` : '',
  ].filter(Boolean);
  return {
    id: id || undefined,
    title,
    content: body.join('\n\n'),
  };
}

function parseMarkdownTickets(markdown: string): TicketDocument[] {
  const lines = markdown.split(/\r?\n/);
  const strictStarts = collectTicketStarts(lines, matchStrictTicketStart);
  const headingStarts = strictStarts.length > 0
    ? strictStarts
    : collectTicketStarts(lines, matchNumberedHeadingStart);
  const starts = headingStarts.length > 0
    ? headingStarts
    : collectTicketStarts(lines, matchNumberedListStart)
      .filter(start => sectionLooksLikeTicket(lines, start.lineIndex));

  return starts.map((start, index) => {
    const nextStart = starts[index + 1]?.lineIndex ?? lines.length;
    const frontierIndex = findFrontierIndex(lines, start.lineIndex + 1, nextStart);
    const end = frontierIndex >= 0 ? frontierIndex : nextStart;
    return {
      id: start.id,
      title: start.title,
      content: lines.slice(start.lineIndex + 1, end).join('\n').trim(),
    };
  });
}

function collectTicketStarts(
  lines: string[],
  matcher: (line: string) => Omit<TicketStart, 'lineIndex'> | null,
): TicketStart[] {
  const starts: TicketStart[] = [];
  lines.forEach((line, lineIndex) => {
    const match = matcher(line);
    if (match) {
      starts.push({ ...match, lineIndex });
    }
  });
  return starts;
}

function matchStrictTicketStart(
  line: string,
): Omit<TicketStart, 'lineIndex'> | null {
  const heading = line.match(
    /^\s{0,3}#{1,6}\s+(?:ticket\s+)?T(\d{1,3})\s*(?:(?:—|–|:|-|\.)\s*)?(.+?)\s*$/i,
  );
  if (heading) {
    return {
      id: `T${heading[1].padStart(2, '0')}`,
      title: cleanTicketTitle(heading[2]),
    };
  }
  const numbered = line.match(
    /^\s*\d+[.)]\s+\*{0,2}(?:ticket\s+)?T(\d{1,3})\s*(?:(?:—|–|:|-|\.)\s*)?(.+?)\*{0,2}\s*$/i,
  );
  if (numbered) {
    return {
      id: `T${numbered[1].padStart(2, '0')}`,
      title: cleanTicketTitle(numbered[2]),
    };
  }
  const bold = line.match(
    /^\s*\*{2}(?:ticket\s+)?T(\d{1,3})\s*(?:(?:—|–|:|-|\.)\s*)?(.+?)\*{2}\s*$/i,
  );
  return bold
    ? {
        id: `T${bold[1].padStart(2, '0')}`,
        title: cleanTicketTitle(bold[2]),
      }
    : null;
}

function matchNumberedHeadingStart(
  line: string,
): Omit<TicketStart, 'lineIndex'> | null {
  const match = line.match(
    /^\s{0,3}#{1,6}\s+(\d{1,3})\s*(?:—|–|:|-|\.)\s*(.+?)\s*$/,
  );
  return match
    ? { id: `T${match[1].padStart(2, '0')}`, title: cleanTicketTitle(match[2]) }
    : null;
}

function matchNumberedListStart(
  line: string,
): Omit<TicketStart, 'lineIndex'> | null {
  const match = line.match(
    /^\s*(\d{1,3})[.)]\s+\*{0,2}(.+?)\*{0,2}\s*$/,
  );
  return match
    ? { id: `T${match[1].padStart(2, '0')}`, title: cleanTicketTitle(match[2]) }
    : null;
}

function sectionLooksLikeTicket(lines: string[], start: number): boolean {
  return lines
    .slice(start + 1, Math.min(lines.length, start + 14))
    .some(line => /\bblocked by\b|\bwhat (?:it delivers|to build)\b/i.test(line));
}

function findFrontierIndex(
  lines: string[],
  start: number,
  end: number,
): number {
  for (let index = start; index < end; index += 1) {
    if (/^\s{0,3}#{1,6}\s+frontier\b/i.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function normalizeTicketDocument(
  ticket: TicketDocument,
  issueNumber: string,
): string {
  const header = `# ${issueNumber} — ${ticket.title}`;
  const id = ticket.id ? `**Ticket ID:** ${ticket.id}` : '';
  return [header, id, ticket.content]
    .filter(Boolean)
    .join('\n\n');
}

function clearGeneratedTicketFiles(issuesDirectory: string): void {
  for (const entry of fs.readdirSync(issuesDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{2,3}-.*\.md$/i.test(entry.name)) {
      fs.rmSync(path.join(issuesDirectory, entry.name), { force: true });
    }
  }
}

function writeMarkdown(filePath: string, content: string): void {
  fs.writeFileSync(filePath, ensureTrailingNewline(content), 'utf8');
}

function ensureTrailingNewline(value: string): string {
  return `${value.trimEnd()}\n`;
}

function renderBulletSection(title: string, values: string[]): string {
  return values.length > 0
    ? `## ${title}\n\n${values.map(value => `- ${value}`).join('\n')}`
    : '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

function cleanTicketTitle(value: string): string {
  return value
    .replace(/\s+#+\s*$/, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .trim();
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function toWorkspacePath(workspaceCwd: string, filePath: string): string {
  const relative = path.relative(workspaceCwd, filePath);
  return relative.split(path.sep).join('/');
}

function assertChildPath(parent: string, child: string): void {
  if (child !== parent && !child.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Refusing to publish pipeline artifacts outside "${parent}".`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
