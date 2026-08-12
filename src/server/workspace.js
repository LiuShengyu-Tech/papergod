import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadProject, saveProject, updateProject } from './project-store.js';
import { syncDocumentStructure } from './document-structure.js';

const TEMPLATE_DOCUMENT = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\title{Untitled Paper}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
Write the abstract here.
\\end{abstract}

\\section{Introduction}
Describe the research problem, gap, and contribution.

\\section{Methods}
Describe the proposed method.

\\section{Results}
Report the main findings.

\\section{Conclusion}
Summarize the contribution and limitations.

\\end{document}
`;

const DEMO_DOCUMENT = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\title{A Reproducible Study of Efficient Scientific Writing Agents}
\\author{Papergod Demo}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
Scientific writing agents can reduce revision time, but their reliability is still unclear. We evaluate a structured agent workflow on 120 annotated manuscript paragraphs and report both editing quality and reproducibility. The workflow improves reviewer acceptance from 71.4\\% to 84.8\\%, while preserving traceable evidence for every accepted change.
\\end{abstract}

\\section{Introduction}
AI-assisted writing is very important for modern research teams. Existing tools often generate fluent prose without preserving the author's intent, evidence, or revision history. This study asks whether a structured workflow with paragraph prompts, reusable language resources, and explicit acceptance decisions can improve academic revisions safely.

\\section{Methods}
We sampled 120 paragraphs from 24 computer-science manuscripts. Three domain experts independently rated clarity, evidence alignment, and terminology consistency on a five-point scale. The proposed workflow combines document-level goals, section prompts, sentence patterns, and scoped vocabulary before producing reviewable edits.

\\section{Results}
The structured workflow increased mean clarity from $3.42 \\pm 0.61$ to $4.18 \\pm 0.47$. Reviewer acceptance increased from 71.4\\% to 84.8\\%, and terminology violations decreased by 38\\%. It was found that explicit paragraph prompts produced the largest improvement.

\\section{Conclusion}
In conclusion, structured writing agents are very useful and can make revision more auditable. The evaluation is limited to computer-science manuscripts, so future work should test additional disciplines and longer collaborative studies.

\\end{document}
`;

const DEMO_SECTION_PROMPTS = {
  Abstract: 'State the problem, evaluation design, quantitative result, and main contribution in a compact standalone summary.',
  Introduction: 'Establish the research gap, explain why unstructured generation is insufficient, and end with the study question.',
  Methods: 'Describe the sample, human evaluation, workflow components, and reproducibility controls precisely.',
  Results: 'Report quantitative findings with units and uncertainty; separate observations from interpretation.',
  Conclusion: 'Answer the research question, state the practical contribution, acknowledge limitations, and identify future work.',
};

function demoResourceBase(id, timestamp) {
  return { id, createdAt: timestamp, updatedAt: timestamp };
}

const STARTER_CORPORA = [
  ['starter_corpus_claim_evidence', 'Claim–evidence checklist', 'Check that every substantive claim is supported at the right strength.', 'Distinguish observations, interpretations, and causal claims. Attach quantitative claims to reported measurements; qualify generalization beyond the evaluated sample; never invent evidence or citations.', ['evidence', 'claims', 'review']],
  ['starter_corpus_reproducibility', 'Reproducibility checklist', 'A compact checklist for empirical and computational papers.', 'Report data selection, preprocessing, sample size, baselines, hyperparameters, evaluation metrics, uncertainty, implementation assumptions, and threats to external validity.', ['methods', 'reproducibility', 'evaluation']],
  ['starter_corpus_structure', 'Section-purpose checklist', 'Keep each paper section focused on its rhetorical job.', 'Introduction: problem, prior capability, gap, and contribution. Methods: auditable procedure. Results: measured findings without interpretation inflation. Discussion: explanation, implications, and limitations. Conclusion: answer the research question without introducing new evidence.', ['structure', 'academic-writing']],
];

const STARTER_PATTERNS = [
  ['starter_pattern_gap', 'Research gap', 'Although {{prior_work}}, existing approaches do not {{unresolved_gap}}.', 'Position an unresolved limitation without dismissing prior work.', ['introduction', 'gap'], ['Introduction'], [['prior_work', 'Capability already established'], ['unresolved_gap', 'Specific unresolved limitation']]],
  ['starter_pattern_contribution', 'Contribution statement', 'This work contributes {{contribution}} by {{mechanism}}, enabling {{outcome}}.', 'State what is new, how it is achieved, and why it matters.', ['introduction', 'contribution'], ['Introduction'], [['contribution', 'Concrete contribution'], ['mechanism', 'Method or design that realizes it'], ['outcome', 'Supported benefit or capability']]],
  ['starter_pattern_protocol', 'Evaluation protocol', 'We evaluate {{system}} on {{sample}} using {{metric}}, with {{control}}.', 'Summarize an auditable evaluation design.', ['methods', 'evaluation'], ['Methods'], [['system', 'Evaluated system'], ['sample', 'Evaluation sample'], ['metric', 'Outcome measure'], ['control', 'Baseline, control, or reliability procedure']]],
  ['starter_pattern_result', 'Quantitative comparison', '{{method}} changed {{metric}} from {{baseline}} to {{result}} ({{uncertainty_or_effect}}).', 'Report a comparison with uncertainty or effect size.', ['results', 'quantitative'], ['Results'], [['method', 'Compared method'], ['metric', 'Measured outcome'], ['baseline', 'Baseline value'], ['result', 'Observed value'], ['uncertainty_or_effect', 'Uncertainty interval or effect size']]],
  ['starter_pattern_negative_result', 'Null or negative result', 'We found no evidence that {{factor}} improved {{outcome}} under {{conditions}} ({{estimate}}).', 'Report a null result without claiming proof of no effect.', ['results', 'negative-result'], ['Results'], [['factor', 'Tested factor'], ['outcome', 'Measured outcome'], ['conditions', 'Evaluation conditions'], ['estimate', 'Estimate and uncertainty']]],
  ['starter_pattern_limitation', 'Limitation and scope', 'This study is limited by {{limitation}}, which may affect {{scope}}; future work should {{next_step}}.', 'Connect a concrete limitation to its consequence and next step.', ['discussion', 'limitations'], ['Discussion', 'Conclusion'], [['limitation', 'Specific limitation'], ['scope', 'Affected inference or generalization'], ['next_step', 'Actionable follow-up']]],
  ['starter_pattern_implication', 'Evidence-bounded implication', 'These findings suggest that {{implication}} when {{condition}}, but they do not establish {{excluded_claim}}.', 'State an implication while preserving the evidence boundary.', ['discussion', 'evidence'], ['Discussion'], [['implication', 'Supported implication'], ['condition', 'Conditions under which it applies'], ['excluded_claim', 'Stronger unsupported conclusion']]],
  ['starter_pattern_contrast', 'Contrast transition', 'Whereas {{first_case}}, {{second_case}}; this difference reflects {{explanation}}.', 'Connect two findings with an explicit basis for contrast.', ['transition', 'cohesion'], ['Results', 'Discussion'], [['first_case', 'First result or condition'], ['second_case', 'Contrasting result or condition'], ['explanation', 'Evidence-supported explanation']]],
];

const STARTER_VOCABULARY = [
  ['starter_vocab_show', 'show', 'demonstrate', 'Use “demonstrate” for direct evidence; use “indicate” or “suggest” when evidence is weaker.', ['indicate', 'suggest', 'reveal'], 'The ablation results demonstrate the contribution of the retrieval module.'],
  ['starter_vocab_prove', 'prove', 'support', 'Empirical results usually support a claim rather than prove it universally.', ['provide evidence for', 'corroborate'], 'The results support the hypothesis under the evaluated conditions.'],
  ['starter_vocab_very', 'very important', 'important', 'Replace vague intensifiers with the specific consequence whenever possible.', ['substantive', 'consequential'], 'This distinction is important because it changes the evaluation protocol.'],
  ['starter_vocab_lot', 'a lot of', 'many', 'Prefer a count or proportion when available; otherwise use a precise quantifier.', ['numerous', 'a substantial proportion of'], 'Many sampled papers omitted uncertainty estimates.'],
  ['starter_vocab_get', 'get', 'obtain', 'Prefer a verb that names the operation or outcome.', ['derive', 'retrieve', 'achieve'], 'We obtain the final representation by mean pooling.'],
  ['starter_vocab_better', 'better', 'higher', 'Name the exact dimension of improvement and report its measure.', ['lower', 'more accurate', 'more efficient'], 'The revised method achieved a higher reviewer acceptance rate.'],
  ['starter_vocab_bad', 'bad', 'limited', 'Describe the observed deficiency rather than applying a broad judgment.', ['inaccurate', 'unstable', 'insufficient'], 'Performance was limited on out-of-domain samples.'],
  ['starter_vocab_obviously', 'obviously', 'notably', 'Avoid implying that a claim is self-evident; state the evidence instead.', ['as expected', 'consistent with'], 'Notably, the effect persisted across all three datasets.'],
  ['starter_vocab_causes', 'causes', 'is associated with', 'Use causal language only when the study design identifies a causal effect.', ['correlates with', 'coincides with'], 'Longer prompts were associated with higher completion latency.'],
  ['starter_vocab_significant', 'significant', 'statistically significant', 'Specify whether significance is statistical or practical and report the criterion.', ['substantial', 'meaningful'], 'The difference was statistically significant at the prespecified threshold.'],
];

export async function seedStarterLibraries(workspaceRoot) {
  const timestamp = new Date().toISOString();
  const { project } = await updateProject(workspaceRoot, (data) => {
    const addMissing = (target, records) => {
      const ids = new Set(target.map((item) => item.id));
      for (const record of records) if (!ids.has(record.id)) target.push(record);
    };
    addMissing(data.libraries.corpora, STARTER_CORPORA.map(([id, name, description, content, tags]) => ({
      ...demoResourceBase(id, timestamp), name, description, content, tags, source: 'Papergod starter library',
    })));
    addMissing(data.libraries.sentencePatterns, STARTER_PATTERNS.map(([id, name, template, description, tags, sectionTypes, slots]) => ({
      ...demoResourceBase(id, timestamp), name, template, description, tags, sectionTypes, source: 'Papergod starter library',
      slots: slots.map(([slotName, slotDescription]) => ({ name: slotName, description: slotDescription, required: true })),
    })));
    addMissing(data.libraries.vocabulary.global, STARTER_VOCABULARY.map(([id, term, preferred, definition, alternatives, example]) => ({
      ...demoResourceBase(id, timestamp), term, preferred, definition, alternatives, examples: [example], tags: ['academic', 'precision'], source: 'Papergod starter library',
    })));
  });
  return project;
}

export async function seedDemoWorkspace(workspaceRoot, file = 'main.tex') {
  const document = await syncDocumentStructure(workspaceRoot, file);
  const timestamp = new Date().toISOString();
  const { project } = await updateProject(workspaceRoot, (data) => {
    data.project.corePrompt ||= 'Revise this empirical computer-science paper for precision, evidence alignment, reproducibility, and consistent terminology. Never invent results or citations; preserve LaTeX and make every change reviewable.';
    const targetDocument = data.documents.find((item) => item.id === document.id);
    targetDocument.summary ||= 'An empirical study of whether structured prompts, writing libraries, and explicit revision decisions improve AI-assisted scientific writing.';
    targetDocument.corePrompt ||= 'Produce a concise, evidence-grounded paper. Keep claims tied to the reported 120-paragraph evaluation and distinguish measured results from interpretation.';
    for (const section of targetDocument.sections) {
      section.prompt ||= DEMO_SECTION_PROMPTS[section.title] || 'Keep this section focused, precise, and connected to the document-level argument.';
      for (const paragraph of section.children || []) {
        paragraph.prompt ||= `Write one coherent ${section.title.toLowerCase()} paragraph with a clear rhetorical purpose and evidence-aware transitions.`;
      }
    }
    if (!data.libraries.corpora.length) data.libraries.corpora.push(
      {
        ...demoResourceBase('demo_corpus_algorithm', timestamp), name: 'Algorithm evaluation checklist',
        description: 'Reusable evidence requirements for empirical algorithm papers.',
        content: 'Define the task and sample; name baselines; report metrics with uncertainty; separate measured findings from causal explanations; state limitations and reproducibility conditions.',
        source: 'Papergod built-in demo', tags: ['algorithm', 'evaluation', 'methods', 'results'],
      },
      {
        ...demoResourceBase('demo_corpus_reproducibility', timestamp), name: 'Reproducibility checklist',
        description: 'Items reviewers expect when assessing reproducible computational work.',
        content: 'Report data selection, annotator procedure, evaluation scale, sample size, uncertainty, implementation assumptions, and threats to external validity.',
        source: 'Papergod built-in demo', tags: ['reproducibility', 'review', 'methods'],
      },
    );
    if (!data.libraries.sentencePatterns.length) data.libraries.sentencePatterns.push(
      {
        ...demoResourceBase('demo_pattern_gap', timestamp), name: 'Research gap',
        template: 'Although {{prior capability}}, existing approaches do not {{unresolved limitation}}.',
        description: 'Contrast prior capability with the unresolved gap.', source: 'Papergod built-in demo',
        tags: ['introduction', 'gap'], sectionTypes: ['Introduction'],
        slots: [{ name: 'prior capability', description: 'What prior work already achieves', required: true }, { name: 'unresolved limitation', description: 'What remains unresolved', required: true }],
      },
      {
        ...demoResourceBase('demo_pattern_method', timestamp), name: 'Evaluation protocol',
        template: 'We evaluate {{system}} on {{sample}} using {{metric}}, with {{control}}.',
        description: 'State an auditable empirical evaluation protocol.', source: 'Papergod built-in demo',
        tags: ['methods', 'evaluation'], sectionTypes: ['Methods'],
        slots: [{ name: 'system', description: 'Evaluated system', required: true }, { name: 'sample', description: 'Evaluation sample', required: true }, { name: 'metric', description: 'Outcome measure', required: true }, { name: 'control', description: 'Control or reliability procedure', required: true }],
      },
      {
        ...demoResourceBase('demo_pattern_result', timestamp), name: 'Quantitative comparison',
        template: '{{method}} improved {{metric}} from {{baseline}} to {{result}}, corresponding to {{effect}}.',
        description: 'Report a comparison without overstating causality.', source: 'Papergod built-in demo',
        tags: ['results', 'quantitative'], sectionTypes: ['Results'],
        slots: [{ name: 'method', description: 'Compared method', required: true }, { name: 'metric', description: 'Reported metric', required: true }, { name: 'baseline', description: 'Baseline value', required: true }, { name: 'result', description: 'Observed value', required: true }, { name: 'effect', description: 'Effect size or change', required: true }],
      },
    );
    if (!data.libraries.vocabulary.global.length) data.libraries.vocabulary.global.push(
      { ...demoResourceBase('demo_vocab_show', timestamp), term: 'show', preferred: 'demonstrate', definition: 'Use for evidence-supported observations.', source: 'Papergod built-in demo', alternatives: ['indicate', 'suggest'], examples: ['The results demonstrate improved consistency.'], tags: ['academic', 'evidence'] },
      { ...demoResourceBase('demo_vocab_accuracy', timestamp), term: 'accuracy', preferred: 'reviewer acceptance rate', definition: 'Use the exact operationalized metric in this demo.', source: 'Papergod built-in demo', alternatives: ['acceptance rate'], examples: ['Reviewer acceptance rate increased to 84.8%.'], tags: ['results', 'metric'] },
    );
    if (!data.libraries.vocabulary.session.length) data.libraries.vocabulary.session.push(
      { ...demoResourceBase('demo_vocab_workflow', timestamp), term: 'our system', preferred: 'the structured workflow', definition: 'Agreed name for the method in this writing session.', source: 'Papergod demo agreement', alternatives: ['Papergod workflow'], examples: ['The structured workflow preserves traceable revision decisions.'], tags: ['terminology', 'session'] },
    );
    if (!data.annotations.length) {
      const sentences = targetDocument.sections.flatMap((section) => (section.children || []).flatMap((paragraph) => paragraph.children || []));
      const styleTarget = sentences.find((sentence) => sentence.text.includes('very important'));
      const evidenceTarget = sentences.find((sentence) => sentence.text.includes('It was found'));
      const addDemoAnnotation = (id, target, category, severity, body, suggestedFix) => {
        if (!target) return;
        data.annotations.push({
          ...demoResourceBase(id, timestamp), documentId: targetDocument.id,
          target: { type: 'sentence', id: target.id, start: target.sourceRange.start, end: target.sourceRange.end, quote: target.text },
          category, severity, body, suggestedFix, status: 'open', dependsOn: [],
          source: { type: 'reviewer', actor: 'Built-in demo reviewer' },
        });
      };
      addDemoAnnotation('demo_annotation_style', styleTarget, 'style', 'minor', 'Replace vague emphasis with a precise statement of practical importance.', 'Name the concrete research-team benefit instead of using “very important”.');
      addDemoAnnotation('demo_annotation_evidence', evidenceTarget, 'evidence', 'major', 'The causal wording is not supported by the reported comparison.', 'Report the observed association and avoid implying that paragraph prompts alone caused the improvement.');
    }
  });
  return project;
}

export async function initializeWorkspace(workspaceRoot, { demo = false } = {}) {
  await mkdir(workspaceRoot, { recursive: true });
  const entries = await readdir(workspaceRoot);
  const texFiles = entries.filter((entry) => entry.endsWith('.tex'));
  let createdSample = false;
  if (texFiles.length === 0) {
    await writeFile(join(workspaceRoot, 'main.tex'), demo ? DEMO_DOCUMENT : TEMPLATE_DOCUMENT, { encoding: 'utf-8', flag: 'wx' });
    createdSample = true;
  }
  let project = await loadProject(workspaceRoot);
  const selectedFile = texFiles.includes('main.tex') || createdSample ? 'main.tex' : texFiles.sort()[0];
  if (project.documents.length === 1 && project.documents[0].file === 'main.tex' && selectedFile !== 'main.tex') {
    project.documents[0].file = selectedFile;
    project = await saveProject(workspaceRoot, project);
  }
  if (demo) project = await seedDemoWorkspace(workspaceRoot, selectedFile);
  project = await seedStarterLibraries(workspaceRoot);
  return { createdSample, project };
}
