function shouldAutoStartAlwaysOnOrchestrator(row) {
  const agent = String(row?.always_on_agent || 'hermes').toLowerCase();
  if (agent === 'claude') return false;
  return true;
}

module.exports = {
  shouldAutoStartAlwaysOnOrchestrator,
};
