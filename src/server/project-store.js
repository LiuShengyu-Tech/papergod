import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';

export const PROJECT_SCHEMA_VERSION = 3;

const PROJECT_DIR = '.papergod';
const PROJECT_FILE = 'project.json';
const updateQueues = new Map();

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function createDefaultProject(workspaceRoot) {
  const timestamp = now();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: {
      id: createId('project'),
      name: basename(workspaceRoot),
      corePrompt: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    documents: [
      {
        id: createId('document'),
        file: 'main.tex',
        title: '',
        summary: '',
        corePrompt: '',
        sections: [],
      },
    ],
    libraries: {
      corpora: [],
      sentencePatterns: [],
      vocabulary: {
        global: [],
        session: [],
      },
    },
    annotations: [],
    reviews: [],
    revisions: [],
    agentRuns: [],
    orchestrations: [],
  };
}

export function migrateProjectData(input, workspaceRoot) {
  if (!isObject(input)) throw new Error('Project data must be an object');
  if (input.schemaVersion === PROJECT_SCHEMA_VERSION) return { data: input, migratedFrom: null };
  if (Number.isInteger(input.schemaVersion) && input.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(`Project schema ${input.schemaVersion} is newer than supported schema ${PROJECT_SCHEMA_VERSION}`);
  }

  const sourceVersion = Number.isInteger(input.schemaVersion) ? input.schemaVersion : 0;
  if (![0, 1, 2].includes(sourceVersion)) throw new Error(`No migration path from project schema ${sourceVersion}`);

  const defaults = createDefaultProject(workspaceRoot);
  const sourceLibraries = isObject(input.libraries) ? input.libraries : {};
  const sourceVocabulary = isObject(sourceLibraries.vocabulary) ? sourceLibraries.vocabulary : {};
  const documents = Array.isArray(input.documents) ? input.documents.map((document) => ({
    id: typeof document?.id === 'string' && document.id ? document.id : createId('document'),
    file: typeof document?.file === 'string' && document.file ? document.file : 'main.tex',
    title: typeof document?.title === 'string' ? document.title : '',
    summary: typeof document?.summary === 'string' ? document.summary : '',
    corePrompt: typeof document?.corePrompt === 'string' ? document.corePrompt : '',
    sections: Array.isArray(document?.sections) ? document.sections : [],
  })) : defaults.documents;

  return {
    migratedFrom: sourceVersion,
    data: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      project: { ...defaults.project, ...(isObject(input.project) ? input.project : {}) },
      documents,
      libraries: {
        corpora: Array.isArray(sourceLibraries.corpora) ? sourceLibraries.corpora : [],
        sentencePatterns: Array.isArray(sourceLibraries.sentencePatterns) ? sourceLibraries.sentencePatterns : [],
        vocabulary: {
          global: Array.isArray(sourceVocabulary.global) ? sourceVocabulary.global : [],
          session: Array.isArray(sourceVocabulary.session) ? sourceVocabulary.session : [],
        },
      },
      annotations: Array.isArray(input.annotations) ? input.annotations : [],
      reviews: Array.isArray(input.reviews) ? input.reviews.map((review) => migrateReview(review)) : [],
      revisions: Array.isArray(input.revisions) ? input.revisions : [],
      agentRuns: Array.isArray(input.agentRuns) ? input.agentRuns : [],
      orchestrations: Array.isArray(input.orchestrations) ? input.orchestrations : [],
    },
  };
}

function migrateReview(review = {}) {
  const timestamp = now();
  const reviewers = Array.isArray(review.reviewers) ? review.reviewers.map((reviewer, index) => {
    if (isObject(reviewer)) return {
      id: typeof reviewer.id === 'string' && reviewer.id ? reviewer.id : createId('reviewer'),
      name: typeof reviewer.name === 'string' && reviewer.name ? reviewer.name : `Legacy reviewer ${index + 1}`,
      role: ['methodology', 'statistics', 'writing', 'domain', 'reproducibility'].includes(reviewer.role) ? reviewer.role : 'domain',
      focus: typeof reviewer.focus === 'string' && reviewer.focus ? reviewer.focus : 'General academic quality and correctness.',
      prompt: typeof reviewer.prompt === 'string' ? reviewer.prompt : '',
    };
    return { id: createId('reviewer'), name: String(reviewer || `Legacy reviewer ${index + 1}`), role: 'domain', focus: 'General academic quality and correctness.', prompt: '' };
  }) : [];
  if (!reviewers.length) reviewers.push({ id: createId('reviewer'), name: 'Legacy reviewer', role: 'domain', focus: 'General academic quality and correctness.', prompt: '' });
  const rubric = Array.isArray(review.rubric) && review.rubric.length ? review.rubric : [
    { id: 'general', title: 'General quality', instruction: 'Assess correctness, evidence, clarity, and significance.', weight: 1 },
  ];
  const items = Array.isArray(review.items) ? review.items.map((item) => ({
    id: typeof item?.id === 'string' && item.id ? item.id : createId('review_item'),
    reviewerId: typeof item?.reviewerId === 'string' && item.reviewerId ? item.reviewerId : reviewers[0].id,
    rubricId: typeof item?.rubricId === 'string' && item.rubricId ? item.rubricId : rubric[0].id,
    kind: item?.kind === 'strength' ? 'strength' : 'concern',
    category: ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'].includes(item?.category) ? item.category : 'other',
    severity: ['info', 'minor', 'major', 'critical'].includes(item?.severity) ? item.severity : 'info',
    body: typeof item?.body === 'string' && item.body ? item.body : typeof item === 'string' ? item : 'Legacy review finding',
    suggestedFix: typeof item?.suggestedFix === 'string' ? item.suggestedFix : '',
    quote: typeof item?.quote === 'string' ? item.quote : '',
  })) : [];
  return {
    ...review,
    id: typeof review.id === 'string' && review.id ? review.id : createId('review'),
    documentId: typeof review.documentId === 'string' ? review.documentId : '',
    name: typeof review.name === 'string' && review.name ? review.name : 'Migrated review round',
    status: ['draft', 'running', 'complete', 'failed'].includes(review.status) ? review.status : 'draft',
    provider: ['mock', 'codex', 'claude-code', 'opencode', 'pi'].includes(review.provider) ? review.provider : 'mock',
    reviewers, rubric, reports: Array.isArray(review.reports) ? review.reports : [], items,
    synthesis: isObject(review.synthesis) ? review.synthesis : { summary: '', verdict: '', consensus: [], conflicts: [], priorities: [] },
    createdAt: typeof review.createdAt === 'string' && review.createdAt ? review.createdAt : timestamp,
    updatedAt: typeof review.updatedAt === 'string' && review.updatedAt ? review.updatedAt : timestamp,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value, path, errors, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    errors.push(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((item, index) => validateString(item, `${path}[${index}]`, errors, { allowEmpty: false }));
}

function validateEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(`${path} must be one of: ${allowed.join(', ')}`);
}

function validateRecordBase(record, path, errors) {
  if (!isObject(record)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  validateString(record.id, `${path}.id`, errors, { allowEmpty: false });
  validateString(record.createdAt, `${path}.createdAt`, errors, { allowEmpty: false });
  validateString(record.updatedAt, `${path}.updatedAt`, errors, { allowEmpty: false });
  return true;
}

function validateCorpus(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.name, `${path}.name`, errors, { allowEmpty: false });
  validateString(item.description, `${path}.description`, errors);
  validateString(item.content, `${path}.content`, errors, { allowEmpty: false });
  validateString(item.source, `${path}.source`, errors);
  validateStringArray(item.tags, `${path}.tags`, errors);
}

function validateSentencePattern(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.name, `${path}.name`, errors, { allowEmpty: false });
  validateString(item.template, `${path}.template`, errors, { allowEmpty: false });
  validateString(item.description, `${path}.description`, errors);
  validateString(item.source, `${path}.source`, errors);
  validateStringArray(item.tags, `${path}.tags`, errors);
  validateStringArray(item.sectionTypes, `${path}.sectionTypes`, errors);
  if (!Array.isArray(item.slots)) {
    errors.push(`${path}.slots must be an array`);
  } else {
    item.slots.forEach((slot, index) => {
      const slotPath = `${path}.slots[${index}]`;
      if (!isObject(slot)) return errors.push(`${slotPath} must be an object`);
      validateString(slot.name, `${slotPath}.name`, errors, { allowEmpty: false });
      validateString(slot.description, `${slotPath}.description`, errors);
      if (typeof slot.required !== 'boolean') errors.push(`${slotPath}.required must be a boolean`);
    });
  }
}

function validateVocabulary(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.term, `${path}.term`, errors, { allowEmpty: false });
  validateString(item.preferred, `${path}.preferred`, errors);
  validateString(item.definition, `${path}.definition`, errors);
  validateString(item.source, `${path}.source`, errors);
  validateStringArray(item.alternatives, `${path}.alternatives`, errors);
  validateStringArray(item.examples, `${path}.examples`, errors);
  validateStringArray(item.tags, `${path}.tags`, errors);
}

function validateTarget(target, path, errors) {
  if (!isObject(target)) return errors.push(`${path} must be an object`);
  validateEnum(target.type, ['document', 'section', 'paragraph', 'sentence', 'range'], `${path}.type`, errors);
  validateString(target.id, `${path}.id`, errors);
  validateString(target.quote, `${path}.quote`, errors);
  for (const field of ['start', 'end']) {
    if (!Number.isInteger(target[field]) || target[field] < 0) errors.push(`${path}.${field} must be a non-negative integer`);
  }
  if (Number.isInteger(target.start) && Number.isInteger(target.end) && target.end < target.start) {
    errors.push(`${path}.end must be greater than or equal to start`);
  }
}

function validateAnnotation(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.documentId, `${path}.documentId`, errors, { allowEmpty: false });
  validateTarget(item.target, `${path}.target`, errors);
  validateEnum(item.category, ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'], `${path}.category`, errors);
  validateEnum(item.severity, ['info', 'minor', 'major', 'critical'], `${path}.severity`, errors);
  validateString(item.body, `${path}.body`, errors, { allowEmpty: false });
  validateString(item.suggestedFix, `${path}.suggestedFix`, errors);
  validateEnum(item.status, ['open', 'planned', 'resolved', 'rejected', 'deferred'], `${path}.status`, errors);
  if (item.order !== undefined && (!Number.isInteger(item.order) || item.order < 0)) errors.push(`${path}.order must be a non-negative integer`);
  if (item.dependsOn !== undefined) validateStringArray(item.dependsOn, `${path}.dependsOn`, errors);
  if (!isObject(item.source)) {
    errors.push(`${path}.source must be an object`);
  } else {
    validateEnum(item.source.type, ['user', 'agent', 'reviewer', 'import'], `${path}.source.type`, errors);
    validateString(item.source.actor, `${path}.source.actor`, errors);
  }
}

function validateChange(item, path, errors) {
  if (!isObject(item)) return errors.push(`${path} must be an object`);
  validateString(item.id, `${path}.id`, errors, { allowEmpty: false });
  validateTarget(item.target, `${path}.target`, errors);
  validateString(item.before, `${path}.before`, errors);
  validateString(item.after, `${path}.after`, errors);
  validateString(item.reason, `${path}.reason`, errors);
  validateEnum(item.status, ['proposed', 'accepted', 'rejected', 'deferred', 'applied', 'reverted'], `${path}.status`, errors);
  if (item.annotationId !== undefined) validateString(item.annotationId, `${path}.annotationId`, errors, { allowEmpty: false });
  if (item.executable !== undefined && typeof item.executable !== 'boolean') errors.push(`${path}.executable must be a boolean`);
  if (item.dependsOn !== undefined) validateStringArray(item.dependsOn, `${path}.dependsOn`, errors);
  if (item.conflictsWith !== undefined) validateStringArray(item.conflictsWith, `${path}.conflictsWith`, errors);
}

function validateRevision(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.documentId, `${path}.documentId`, errors, { allowEmpty: false });
  validateString(item.title, `${path}.title`, errors, { allowEmpty: false });
  validateString(item.summary, `${path}.summary`, errors);
  validateEnum(item.status, ['draft', 'planned', 'running', 'review', 'applied', 'rolled-back', 'cancelled', 'failed'], `${path}.status`, errors);
  if (item.file !== undefined) validateString(item.file, `${path}.file`, errors, { allowEmpty: false });
  validateStringArray(item.annotationIds, `${path}.annotationIds`, errors);
  if (!Array.isArray(item.changes)) {
    errors.push(`${path}.changes must be an array`);
  } else {
    item.changes.forEach((change, index) => validateChange(change, `${path}.changes[${index}]`, errors));
  }
  if (item.graph !== undefined) {
    if (!isObject(item.graph) || !Array.isArray(item.graph.nodes) || !Array.isArray(item.graph.edges)) {
      errors.push(`${path}.graph must contain nodes and edges arrays`);
    }
  }
  if (item.recoveryPoint !== undefined && item.recoveryPoint !== null) {
    if (!isObject(item.recoveryPoint)) errors.push(`${path}.recoveryPoint must be an object or null`);
    else {
      for (const field of ['id', 'file', 'path', 'sourceHash', 'appliedHash', 'createdAt']) {
        validateString(item.recoveryPoint[field], `${path}.recoveryPoint.${field}`, errors, { allowEmpty: false });
      }
    }
  }
  if (item.appliedAt !== undefined) validateString(item.appliedAt, `${path}.appliedAt`, errors, { allowEmpty: false });
  if (item.rolledBackAt !== undefined) validateString(item.rolledBackAt, `${path}.rolledBackAt`, errors, { allowEmpty: false });
  if (item.origin !== undefined) validateEnum(item.origin, ['paper-generation', 'paragraph-generation', 'agent-suggestion', 'agent-batch', 'history-restore'], `${path}.origin`, errors);
  if (item.generation !== undefined) {
    if (!isObject(item.generation)) errors.push(`${path}.generation must be an object`);
    else {
      validateString(item.generation.runId, `${path}.generation.runId`, errors, { allowEmpty: false });
      validateString(item.generation.instruction, `${path}.generation.instruction`, errors);
      validateStringArray(item.generation.providedResourceIds, `${path}.generation.providedResourceIds`, errors);
      validateStringArray(item.generation.usedResourceIds, `${path}.generation.usedResourceIds`, errors);
    }
  }
  if (item.responseLetter !== undefined) {
    if (!isObject(item.responseLetter)) errors.push(`${path}.responseLetter must be an object`);
    else {
      validateString(item.responseLetter.title, `${path}.responseLetter.title`, errors, { allowEmpty: false });
      validateString(item.responseLetter.introduction, `${path}.responseLetter.introduction`, errors);
      if (!Array.isArray(item.responseLetter.items)) errors.push(`${path}.responseLetter.items must be an array`);
      else item.responseLetter.items.forEach((response, index) => {
        const responsePath = `${path}.responseLetter.items[${index}]`;
        if (!isObject(response)) return errors.push(`${responsePath} must be an object`);
        for (const field of ['annotationId', 'opinion', 'response', 'status', 'location']) validateString(response[field], `${responsePath}.${field}`, errors, { allowEmpty: field === 'location' });
        if (!Number.isInteger(response.order) || response.order < 0) errors.push(`${responsePath}.order must be a non-negative integer`);
      });
    }
  }
  if (item.changeList !== undefined) {
    if (!Array.isArray(item.changeList)) errors.push(`${path}.changeList must be an array`);
    else item.changeList.forEach((change, index) => {
      const changePath = `${path}.changeList[${index}]`;
      if (!isObject(change)) return errors.push(`${changePath} must be an object`);
      for (const field of ['changeId', 'annotationId', 'status', 'location', 'before', 'after', 'reason']) validateString(change[field], `${changePath}.${field}`, errors, { allowEmpty: field !== 'changeId' });
      if (!Number.isInteger(change.order) || change.order < 0) errors.push(`${changePath}.order must be a non-negative integer`);
    });
  }
  if (item.verification !== undefined) {
    if (!isObject(item.verification) || !isObject(item.verification.compile)) errors.push(`${path}.verification must contain compile`);
    else {
      validateString(item.verification.checkedAt, `${path}.verification.checkedAt`, errors, { allowEmpty: false });
      if (typeof item.verification.compile.ok !== 'boolean') errors.push(`${path}.verification.compile.ok must be a boolean`);
      validateString(item.verification.compile.engine, `${path}.verification.compile.engine`, errors);
      validateString(item.verification.compile.error, `${path}.verification.compile.error`, errors);
      validateStringArray(item.verification.unresolvedAnnotationIds, `${path}.verification.unresolvedAnnotationIds`, errors);
      if (typeof item.verification.complete !== 'boolean') errors.push(`${path}.verification.complete must be a boolean`);
    }
  }
}

function validateReview(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.documentId, `${path}.documentId`, errors, { allowEmpty: false });
  validateString(item.name, `${path}.name`, errors, { allowEmpty: false });
  validateEnum(item.status, ['draft', 'running', 'complete', 'failed'], `${path}.status`, errors);
  validateEnum(item.provider, ['mock', 'codex', 'claude-code', 'opencode', 'pi'], `${path}.provider`, errors);
  if (!Array.isArray(item.reviewers)) errors.push(`${path}.reviewers must be an array`);
  else item.reviewers.forEach((reviewer, index) => {
    const reviewerPath = `${path}.reviewers[${index}]`;
    if (!isObject(reviewer)) return errors.push(`${reviewerPath} must be an object`);
    for (const field of ['id', 'name', 'role', 'focus']) validateString(reviewer[field], `${reviewerPath}.${field}`, errors, { allowEmpty: false });
    validateString(reviewer.prompt, `${reviewerPath}.prompt`, errors);
    validateEnum(reviewer.role, ['methodology', 'statistics', 'writing', 'domain', 'reproducibility'], `${reviewerPath}.role`, errors);
  });
  if (!Array.isArray(item.rubric)) errors.push(`${path}.rubric must be an array`);
  else item.rubric.forEach((criterion, index) => {
    const criterionPath = `${path}.rubric[${index}]`;
    if (!isObject(criterion)) return errors.push(`${criterionPath} must be an object`);
    for (const field of ['id', 'title', 'instruction']) validateString(criterion[field], `${criterionPath}.${field}`, errors, { allowEmpty: false });
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) errors.push(`${criterionPath}.weight must be a positive number`);
  });
  const validateReviewItem = (reviewItem, itemPath) => {
    if (!isObject(reviewItem)) return errors.push(`${itemPath} must be an object`);
    for (const field of ['id', 'reviewerId', 'rubricId', 'body']) validateString(reviewItem[field], `${itemPath}.${field}`, errors, { allowEmpty: false });
    validateEnum(reviewItem.kind, ['concern', 'strength'], `${itemPath}.kind`, errors);
    validateEnum(reviewItem.category, ['content', 'structure', 'method', 'evidence', 'style', 'grammar', 'citation', 'other'], `${itemPath}.category`, errors);
    validateEnum(reviewItem.severity, ['info', 'minor', 'major', 'critical'], `${itemPath}.severity`, errors);
    validateString(reviewItem.suggestedFix, `${itemPath}.suggestedFix`, errors);
    validateString(reviewItem.quote, `${itemPath}.quote`, errors);
  };
  if (!Array.isArray(item.reports)) errors.push(`${path}.reports must be an array`);
  else item.reports.forEach((report, index) => {
    const reportPath = `${path}.reports[${index}]`;
    if (!isObject(report)) return errors.push(`${reportPath} must be an object`);
    for (const field of ['id', 'reviewerId', 'runId', 'createdAt']) validateString(report[field], `${reportPath}.${field}`, errors, { allowEmpty: false });
    validateEnum(report.status, ['complete', 'failed'], `${reportPath}.status`, errors);
    validateString(report.summary, `${reportPath}.summary`, errors);
    validateEnum(report.verdict, ['accept', 'minor-revision', 'major-revision', 'reject'], `${reportPath}.verdict`, errors);
    if (typeof report.confidence !== 'number' || report.confidence < 0 || report.confidence > 1) errors.push(`${reportPath}.confidence must be between 0 and 1`);
    validateString(report.error, `${reportPath}.error`, errors);
    if (!Array.isArray(report.items)) errors.push(`${reportPath}.items must be an array`);
    else report.items.forEach((reviewItem, itemIndex) => validateReviewItem(reviewItem, `${reportPath}.items[${itemIndex}]`));
  });
  if (!Array.isArray(item.items)) errors.push(`${path}.items must be an array`);
  else item.items.forEach((reviewItem, index) => validateReviewItem(reviewItem, `${path}.items[${index}]`));
  if (!isObject(item.synthesis)) errors.push(`${path}.synthesis must be an object`);
  else {
    validateString(item.synthesis.summary, `${path}.synthesis.summary`, errors);
    validateString(item.synthesis.verdict, `${path}.synthesis.verdict`, errors);
    for (const field of ['consensus', 'conflicts', 'priorities']) {
      if (!Array.isArray(item.synthesis[field])) errors.push(`${path}.synthesis.${field} must be an array`);
    }
  }
}

function validateAgentRun(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateEnum(item.provider, ['mock', 'codex', 'claude-code', 'opencode', 'pi'], `${path}.provider`, errors);
  validateString(item.operation, `${path}.operation`, errors, { allowEmpty: false });
  validateEnum(item.status, ['queued', 'running', 'complete', 'failed', 'cancelled'], `${path}.status`, errors);
  validateString(item.prompt, `${path}.prompt`, errors);
  validateString(item.input, `${path}.input`, errors);
  validateString(item.output, `${path}.output`, errors);
  validateString(item.error, `${path}.error`, errors);
  validateString(item.startedAt, `${path}.startedAt`, errors);
  validateString(item.finishedAt, `${path}.finishedAt`, errors);
}

const ORCHESTRATION_NODE_KINDS = ['agent', 'gate'];
const ORCHESTRATION_NODE_STATUSES = ['idle', 'queued', 'running', 'complete', 'failed', 'waiting', 'skipped'];
const ORCHESTRATION_CAPABILITIES = ['suggest', 'review', 'paragraph', 'generate'];
const ORCHESTRATION_PROVIDERS = ['mock', 'codex', 'claude-code', 'opencode', 'pi'];
const ORCHESTRATION_REVIEW_ROLES = ['methodology', 'statistics', 'writing', 'domain', 'reproducibility'];

function validateOrchestrationNode(node, path, errors) {
  if (!isObject(node)) return errors.push(`${path} must be an object`);
  validateString(node.id, `${path}.id`, errors, { allowEmpty: false });
  validateEnum(node.kind, ORCHESTRATION_NODE_KINDS, `${path}.kind`, errors);
  validateString(node.label, `${path}.label`, errors);
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) errors.push(`${path}.x and y must be numbers`);
  validateString(node.prompt, `${path}.prompt`, errors);
  validateEnum(node.status, ORCHESTRATION_NODE_STATUSES, `${path}.status`, errors);
  validateString(node.runId, `${path}.runId`, errors);
  validateString(node.error, `${path}.error`, errors);
  validateString(node.startedAt, `${path}.startedAt`, errors);
  validateString(node.finishedAt, `${path}.finishedAt`, errors);
  if (node.kind === 'agent') {
    validateEnum(node.provider, ORCHESTRATION_PROVIDERS, `${path}.provider`, errors);
    validateEnum(node.capability, ORCHESTRATION_CAPABILITIES, `${path}.capability`, errors);
  }
  if (node.kind === 'gate') {
    if (node.decision !== undefined) validateEnum(node.decision, ['pending', 'approved', 'rejected'], `${path}.decision`, errors);
    validateString(node.note, `${path}.note`, errors);
  }
  if (node.source !== undefined) {
    if (!isObject(node.source)) errors.push(`${path}.source must be an object`);
    else {
      validateEnum(node.source.type, ['manual', 'upstream'], `${path}.source.type`, errors);
      validateString(node.source.nodeId, `${path}.source.nodeId`, errors);
      validateString(node.source.text, `${path}.source.text`, errors);
    }
  }
  if (node.output !== undefined && node.output !== null) {
    if (!isObject(node.output)) errors.push(`${path}.output must be an object or null`);
    else {
      validateString(node.output.summary, `${path}.output.summary`, errors);
      validateString(node.output.data, `${path}.output.data`, errors);
      validateString(node.output.contentType, `${path}.output.contentType`, errors);
    }
  }
  if (node.reviewer !== undefined && node.reviewer !== null) {
    if (!isObject(node.reviewer)) errors.push(`${path}.reviewer must be an object or null`);
    else {
      for (const field of ['name', 'focus', 'prompt']) validateString(node.reviewer[field], `${path}.reviewer.${field}`, errors);
      validateEnum(node.reviewer.role, ORCHESTRATION_REVIEW_ROLES, `${path}.reviewer.role`, errors);
    }
  }
  if (node.rubric !== undefined) {
    if (!Array.isArray(node.rubric)) errors.push(`${path}.rubric must be an array`);
    else node.rubric.forEach((criterion, index) => {
      const criterionPath = `${path}.rubric[${index}]`;
      if (!isObject(criterion)) return errors.push(`${criterionPath} must be an object`);
      for (const field of ['id', 'title', 'instruction']) validateString(criterion[field], `${criterionPath}.${field}`, errors, { allowEmpty: false });
      if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) errors.push(`${criterionPath}.weight must be a positive number`);
    });
  }
}

function validateOrchestration(item, path, errors) {
  if (!validateRecordBase(item, path, errors)) return;
  validateString(item.name, `${path}.name`, errors, { allowEmpty: false });
  validateEnum(item.status, ['draft', 'running', 'complete', 'failed', 'cancelled'], `${path}.status`, errors);
  const nodeIds = new Set();
  if (!Array.isArray(item.nodes)) {
    errors.push(`${path}.nodes must be an array`);
  } else if (item.nodes.length > 50) {
    errors.push(`${path}.nodes must contain at most 50 nodes`);
  } else {
    item.nodes.forEach((node, index) => {
      const nodePath = `${path}.nodes[${index}]`;
      validateOrchestrationNode(node, nodePath, errors);
      if (typeof node?.id === 'string' && node.id) {
        if (nodeIds.has(node.id)) errors.push(`${nodePath}.id is duplicated`);
        nodeIds.add(node.id);
      }
    });
    item.nodes.forEach((node, index) => {
      if (node?.source?.type === 'upstream' && node.source.nodeId && !nodeIds.has(node.source.nodeId)) {
        errors.push(`${path}.nodes[${index}].source.nodeId does not reference a node`);
      }
    });
  }
  if (!Array.isArray(item.edges)) {
    errors.push(`${path}.edges must be an array`);
  } else if (item.edges.length > 200) {
    errors.push(`${path}.edges must contain at most 200 edges`);
  } else {
    const pairs = new Set();
    item.edges.forEach((edge, index) => {
      const edgePath = `${path}.edges[${index}]`;
      if (!isObject(edge)) return errors.push(`${edgePath} must be an object`);
      validateString(edge.id, `${edgePath}.id`, errors, { allowEmpty: false });
      validateString(edge.source, `${edgePath}.source`, errors, { allowEmpty: false });
      validateString(edge.target, `${edgePath}.target`, errors, { allowEmpty: false });
      validateString(edge.summary, `${edgePath}.summary`, errors);
      if (edge.source !== 'start' && !nodeIds.has(edge.source)) errors.push(`${edgePath}.source does not reference a node`);
      if (edge.target !== 'end' && !nodeIds.has(edge.target)) errors.push(`${edgePath}.target does not reference a node`);
      if (edge.target === 'start') errors.push(`${edgePath}.target cannot be the start`);
      if (edge.source === 'end') errors.push(`${edgePath}.source cannot be the end`);
      if (edge.source === edge.target && edge.source !== 'start' && edge.source !== 'end') errors.push(`${edgePath} cannot be a self loop`);
      const pair = `${edge.source}->${edge.target}`;
      if (pairs.has(pair)) errors.push(`${edgePath} duplicates an existing edge`);
      pairs.add(pair);
    });
  }
}

function validateNode(node, type, path, errors) {
  if (!isObject(node)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateString(node.id, `${path}.id`, errors, { allowEmpty: false });
  if (node.type !== type) errors.push(`${path}.type must be "${type}"`);
  validateString(node.parentId, `${path}.parentId`, errors);
  if (!Number.isFinite(node.order)) errors.push(`${path}.order must be a number`);
  validateString(node.text, `${path}.text`, errors);
  validateString(node.prompt, `${path}.prompt`, errors);
  validateString(node.summary, `${path}.summary`, errors);
  if (node.sourceRange !== undefined) {
    if (!isObject(node.sourceRange)) errors.push(`${path}.sourceRange must be an object`);
    else {
      for (const field of ['start', 'end', 'contentStart', 'contentEnd']) {
        if (!Number.isInteger(node.sourceRange[field]) || node.sourceRange[field] < 0) {
          errors.push(`${path}.sourceRange.${field} must be a non-negative integer`);
        }
      }
      if (node.sourceRange.end < node.sourceRange.start) errors.push(`${path}.sourceRange.end must be greater than or equal to start`);
      if (node.sourceRange.contentStart < node.sourceRange.start || node.sourceRange.contentEnd > node.sourceRange.end) {
        errors.push(`${path}.sourceRange content must be contained in the node range`);
      }
    }
  }
  if (type === 'sentence') validateString(node.intent, `${path}.intent`, errors);
  if (type !== 'sentence') {
    if (!Array.isArray(node.children)) {
      errors.push(`${path}.children must be an array`);
    } else {
      const childType = type === 'section' ? 'paragraph' : 'sentence';
      node.children.forEach((child, index) => validateNode(child, childType, `${path}.children[${index}]`, errors));
    }
  }
}

function collectNodeIds(nodes, ids, errors) {
  for (const node of nodes) {
    if (typeof node?.id === 'string') {
      if (ids.has(node.id)) errors.push(`duplicate id: ${node.id}`);
      ids.add(node.id);
    }
    if (Array.isArray(node?.children)) collectNodeIds(node.children, ids, errors);
  }
}

export function validateProject(data) {
  const errors = [];
  if (!isObject(data)) return { ok: false, errors: ['project data must be an object'] };
  if (data.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROJECT_SCHEMA_VERSION}`);
  }

  if (!isObject(data.project)) {
    errors.push('project must be an object');
  } else {
    validateString(data.project.id, 'project.id', errors, { allowEmpty: false });
    validateString(data.project.name, 'project.name', errors, { allowEmpty: false });
    validateString(data.project.corePrompt, 'project.corePrompt', errors);
    if (data.project.activeAgentProvider !== undefined) validateEnum(data.project.activeAgentProvider, ['mock', 'codex', 'claude-code', 'opencode', 'pi'], 'project.activeAgentProvider', errors);
    validateString(data.project.createdAt, 'project.createdAt', errors, { allowEmpty: false });
    validateString(data.project.updatedAt, 'project.updatedAt', errors, { allowEmpty: false });
  }

  const documentIds = new Set();
  const targetIds = new Set();
  const allIds = new Set();
  const registerId = (value, path) => {
    if (typeof value !== 'string' || !value) return;
    if (allIds.has(value)) errors.push(`duplicate id at ${path}: ${value}`);
    allIds.add(value);
  };
  if (isObject(data.project)) registerId(data.project.id, 'project.id');

  if (!Array.isArray(data.documents)) {
    errors.push('documents must be an array');
  } else {
    for (const [index, document] of data.documents.entries()) {
      const path = `documents[${index}]`;
      if (!isObject(document)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      validateString(document.id, `${path}.id`, errors, { allowEmpty: false });
      validateString(document.file, `${path}.file`, errors, { allowEmpty: false });
      validateString(document.title, `${path}.title`, errors);
      validateString(document.summary, `${path}.summary`, errors);
      validateString(document.corePrompt, `${path}.corePrompt`, errors);
      if (document.sourceHash !== undefined) validateString(document.sourceHash, `${path}.sourceHash`, errors, { allowEmpty: false });
      if (document.sourceLength !== undefined && (!Number.isInteger(document.sourceLength) || document.sourceLength < 0)) {
        errors.push(`${path}.sourceLength must be a non-negative integer`);
      }
      registerId(document.id, `${path}.id`);
      if (typeof document.id === 'string') {
        documentIds.add(document.id);
        targetIds.add(document.id);
      }
      if (!Array.isArray(document.sections)) {
        errors.push(`${path}.sections must be an array`);
      } else {
        document.sections.forEach((section, sectionIndex) => {
          validateNode(section, 'section', `${path}.sections[${sectionIndex}]`, errors);
        });
        const nodeIds = new Set();
        collectNodeIds(document.sections, nodeIds, errors);
        for (const nodeId of nodeIds) {
          registerId(nodeId, `${path}.sections`);
          targetIds.add(nodeId);
        }
      }
    }
  }

  if (!isObject(data.libraries)) {
    errors.push('libraries must be an object');
  } else {
    if (!Array.isArray(data.libraries.corpora)) errors.push('libraries.corpora must be an array');
    else data.libraries.corpora.forEach((item, index) => {
      validateCorpus(item, `libraries.corpora[${index}]`, errors);
      registerId(item?.id, `libraries.corpora[${index}].id`);
    });
    if (!Array.isArray(data.libraries.sentencePatterns)) errors.push('libraries.sentencePatterns must be an array');
    else data.libraries.sentencePatterns.forEach((item, index) => {
      validateSentencePattern(item, `libraries.sentencePatterns[${index}]`, errors);
      registerId(item?.id, `libraries.sentencePatterns[${index}].id`);
    });
    if (!isObject(data.libraries.vocabulary)) {
      errors.push('libraries.vocabulary must be an object');
    } else {
      if (!Array.isArray(data.libraries.vocabulary.global)) errors.push('libraries.vocabulary.global must be an array');
      else data.libraries.vocabulary.global.forEach((item, index) => {
        validateVocabulary(item, `libraries.vocabulary.global[${index}]`, errors);
        registerId(item?.id, `libraries.vocabulary.global[${index}].id`);
      });
      if (!Array.isArray(data.libraries.vocabulary.session)) errors.push('libraries.vocabulary.session must be an array');
      else data.libraries.vocabulary.session.forEach((item, index) => {
        validateVocabulary(item, `libraries.vocabulary.session[${index}]`, errors);
        registerId(item?.id, `libraries.vocabulary.session[${index}].id`);
      });
    }
  }

  if (!Array.isArray(data.annotations)) errors.push('annotations must be an array');
  else data.annotations.forEach((item, index) => {
    const path = `annotations[${index}]`;
    validateAnnotation(item, path, errors);
    registerId(item?.id, `${path}.id`);
    if (typeof item?.documentId === 'string' && !documentIds.has(item.documentId)) errors.push(`${path}.documentId does not reference a document`);
    if (item?.target?.id && !targetIds.has(item.target.id)) errors.push(`${path}.target.id does not reference a document node`);
    item?.dependsOn?.forEach((annotationId, dependencyIndex) => {
      if (!data.annotations.some((annotation) => annotation.id === annotationId)) errors.push(`${path}.dependsOn[${dependencyIndex}] does not reference an annotation`);
    });
  });
  if (!Array.isArray(data.reviews)) errors.push('reviews must be an array');
  else data.reviews.forEach((item, index) => {
    const path = `reviews[${index}]`;
    validateReview(item, path, errors);
    registerId(item?.id, `${path}.id`);
    if (typeof item?.documentId === 'string' && !documentIds.has(item.documentId)) errors.push(`${path}.documentId does not reference a document`);
  });
  if (!Array.isArray(data.revisions)) errors.push('revisions must be an array');
  else data.revisions.forEach((item, index) => {
    const path = `revisions[${index}]`;
    validateRevision(item, path, errors);
    registerId(item?.id, `${path}.id`);
    if (typeof item?.documentId === 'string' && !documentIds.has(item.documentId)) errors.push(`${path}.documentId does not reference a document`);
    item?.annotationIds?.forEach((annotationId, annotationIndex) => {
      if (!data.annotations?.some((annotation) => annotation.id === annotationId)) errors.push(`${path}.annotationIds[${annotationIndex}] does not reference an annotation`);
    });
    item?.changes?.forEach((change, changeIndex) => registerId(change?.id, `${path}.changes[${changeIndex}].id`));
  });
  if (!Array.isArray(data.agentRuns)) errors.push('agentRuns must be an array');
  else data.agentRuns.forEach((item, index) => {
    validateAgentRun(item, `agentRuns[${index}]`, errors);
    registerId(item?.id, `agentRuns[${index}].id`);
  });
  if (!Array.isArray(data.orchestrations)) errors.push('orchestrations must be an array');
  else data.orchestrations.forEach((item, index) => {
    const path = `orchestrations[${index}]`;
    validateOrchestration(item, path, errors);
    registerId(item?.id, `${path}.id`);
  });

  return { ok: errors.length === 0, errors };
}

function projectPath(workspaceRoot) {
  return join(workspaceRoot, PROJECT_DIR, PROJECT_FILE);
}

export async function loadProject(workspaceRoot) {
  const file = projectPath(workspaceRoot);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    const migration = migrateProjectData(parsed, workspaceRoot);
    const data = migration.data;
    const validation = validateProject(data);
    if (!validation.ok) {
      throw new Error(`Invalid project data: ${validation.errors.join('; ')}`);
    }
    if (migration.migratedFrom !== null) return await saveProject(workspaceRoot, data);
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = createDefaultProject(workspaceRoot);
    await saveProject(workspaceRoot, data);
    return data;
  }
}

export async function saveProject(workspaceRoot, data) {
  const validation = validateProject(data);
  if (!validation.ok) {
    const error = new Error('Invalid project data');
    error.code = 'INVALID_PROJECT';
    error.details = validation.errors;
    throw error;
  }

  const directory = join(workspaceRoot, PROJECT_DIR);
  const file = projectPath(workspaceRoot);
  const temporary = join(directory, `project.${process.pid}.${randomUUID()}.tmp`);
  const stored = structuredClone(data);
  stored.project.updatedAt = now();

  await mkdir(directory, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  // On Windows the atomic rename can transiently fail with EPERM/EBUSY when another
  // handle briefly holds the destination (e.g. a concurrent read during Agent runs).
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, file);
      break;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt > 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
  return stored;
}

export async function updateProject(workspaceRoot, mutate) {
  const previous = updateQueues.get(workspaceRoot) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await loadProject(workspaceRoot);
    const draft = structuredClone(current);
    const result = await mutate(draft);
    const project = await saveProject(workspaceRoot, draft);
    return { project, result };
  });
  updateQueues.set(workspaceRoot, operation);
  try {
    return await operation;
  } finally {
    if (updateQueues.get(workspaceRoot) === operation) updateQueues.delete(workspaceRoot);
  }
}
