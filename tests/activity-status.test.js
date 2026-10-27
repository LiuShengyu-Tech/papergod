import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Activity completion only marks executed stages complete', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const finish = source.slice(source.indexOf('function finishAgentActivity('), source.indexOf('async function undoLastAiRevision('));
  for (const scenario of [
    { options: { outcome: 'incomplete', completedThrough: 'run' }, count: 2, label: 'activity.incomplete' },
    { options: { outcome: 'noChanges', completedThrough: 'run' }, count: 2, label: 'activity.noChanges' },
    { options: { outcome: 'incomplete', completedThrough: 'apply' }, count: 3, label: 'activity.incomplete' },
    { options: {}, count: 4, label: 'activity.complete' },
    { options: { error: true }, count: 1, label: 'activity.failed' },
  ]) {
    const element = () => ({ dataset: {}, classList: { remove() {}, add() {}, toggle(key, value) { this[key] = value; } } });
    const stages = ['prepare', 'run', 'apply', 'compile'].map(stage => ({ ...element(), dataset: { stage } }));
    const elements = new Map();
    const document = { querySelectorAll: () => stages, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
    runInNewContext(`${finish}\nfinishAgentActivity('result', options);`, {
      document, options: scenario.options, AGENT_ACTIVITY_STAGE_ORDER: ['prepare', 'run', 'apply', 'compile'],
      agentActivityStage: 'run', agentActivityTimer: null, agentActivityPoll: null, agentActivityController: null,
      lastAiRevisionId: null, lastAiIntentIds: [], clearInterval() {}, pollAgentActivity() {}, renderAgentActivityLog() {}, t: key => key,
    });
    assert.equal(stages.filter(stage => stage.classList.complete).length, scenario.count);
    assert.equal(document.getElementById('agent-activity-label').textContent, scenario.label);
    assert.ok(stages.every(stage => !stage.classList.active));
  }
});

test('Late local CLI response cannot overwrite newer external activity', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollAgentActivity('), source.indexOf('function setAgentActivityStage('));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = {
    agentActivityId: 'old-mock-job', agentActivityTerminalLog: '',
    fetch: async () => { await pending; return { ok: true, json: async () => ({ output: 'obsolete Mock output' }) }; },
    renderAgentActivityLog() { throw new Error('Stale output was rendered'); },
  };
  const result = runInNewContext(`${poll}\npollAgentActivity();`, context);
  context.agentActivityId = null;
  release(); await result;
  assert.equal(context.agentActivityTerminalLog, '');
});
