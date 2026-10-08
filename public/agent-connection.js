export function connectionSteps(profile, activeProvider, running = false) {
  const local = profile.id === 'mock';
  return [
    local || profile.available ? 'done' : 'pending',
    local || profile.authenticated ? 'done' : 'pending',
    running ? 'running' : local || profile.liveCheck?.ok ? 'done' : profile.liveCheck?.ok === false ? 'failed' : 'pending',
    profile.id === activeProvider ? 'done' : 'pending',
  ];
}
