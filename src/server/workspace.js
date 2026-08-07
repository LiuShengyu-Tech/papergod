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
  return { createdSample, project };
}
