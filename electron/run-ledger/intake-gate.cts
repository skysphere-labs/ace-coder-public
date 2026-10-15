// intake-gate — the pure fail-fast checks runSubmit applies BEFORE minting a
// run. Everything here is inevitable-at-dispatch anyway (spine-effects needs
// scope.workspaceId to spawn; parseSpec rejects acceptance-less specs), so
// failing at the door converts a "run mints, then blocks a tick later, then
// the caller resubmits" turn-burner into a single sub-second command error
// with the exact flag to fix. Pure: no I/O, no store access — the caller
// resolves the workspace row and passes it in.
//
// NOTE: this gate guards the runSubmit IPC seam (the CLI path) only. Loop
// submissions go through loops-service.submitIntent, which synthesizes a
// non-empty acceptance from the goal (deriveAcceptanceFromGoal) before the
// spine sees the spec — they never need or hit this gate.

/**
 * Validate a run intent at intake. Throws with an actionable message on the
 * first failed check; returns { acceptance } (the trimmed non-empty criteria)
 * when the intent is dispatchable.
 * @param {{ intent: any, workspaceId: string|null, workspace: any }} args —
 *   workspaceId/workspace as resolved by the caller (workspaceForRunIntent).
 */
function validateRunIntake({ intent, workspaceId, workspace }: any = {}) {
  const spec = intent && typeof intent === 'object' ? intent : {};
  if (!workspaceId) {
    throw new Error('runSubmit: scope.workspaceId required (pass --workspace <projects.id>) — refusing to mint a run that can never dispatch');
  }
  if (!workspace) {
    throw new Error(`runSubmit: workspace ${workspaceId} not found in this Ace instance — run \`ace doctor workspace\` to list valid ids`);
  }
  const acceptance = Array.isArray(spec.acceptance)
    ? spec.acceptance.filter((a: any) => typeof a === 'string' && a.trim()).map((a: string) => a.trim())
    : [];
  if (acceptance.length === 0) {
    throw new Error('runSubmit: at least one acceptance criterion required (pass --acceptance "<binary check>") — dispatch would otherwise block on parseSpec');
  }
  return { acceptance };
}

module.exports = { validateRunIntake };
