// Props-driven Storage section. No IPC here — a later integration unit mounts
// this inside PreferencesScreen and wires the data-root/operator actions
// through. The change-root flow is deliberately blunt about NOT moving data
// and never relaunches the app itself.

import { useState } from 'react';
import { Badge } from '../ui/badge';
import { ActionButton, SettingsRow, SettingsSection } from './primitives';
import {
  buildChangeRootConfirmation,
  DB_WARNING_COPY,
  describeDataRoot,
  describeOperatorHome,
  RELAUNCH_REQUIRED_NOTICE,
  validatePickedDirectory,
  type DataRootLike,
  type OperatorLike,
} from './storage-section-logic';

type PendingChange =
  | { step: 'db-warning'; picked: string }
  | { step: 'confirm'; picked: string };

export function StorageSection({
  dataRoot,
  onPickDirectory,
  onSetDataRoot,
  destinationHasDb,
  operators,
  onSetOperatorHome,
}: {
  dataRoot: DataRootLike;
  onPickDirectory: () => Promise<string | null>;
  onSetDataRoot: (root: string) => void | Promise<void>;
  destinationHasDb?: (root: string) => Promise<boolean>;
  operators: OperatorLike[];
  onSetOperatorHome: (id: string, path: string) => void;
}) {
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [relaunchRequired, setRelaunchRequired] = useState(false);

  const rootInfo = describeDataRoot(dataRoot);

  const startChange = async () => {
    setError(null);
    let picked: string | null = null;
    try {
      picked = await onPickDirectory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the directory picker.');
      return;
    }
    if (picked === null) return;
    const trimmed = picked.trim();
    const validation = validatePickedDirectory(dataRoot.root, trimmed);
    if (!validation.ok) {
      setError(validation.reason);
      return;
    }
    if (destinationHasDb) {
      let hasDb = false;
      try {
        hasDb = await destinationHasDb(trimmed);
      } catch {
        // Probe failure is non-fatal; fall through to the normal confirmation.
      }
      if (hasDb) {
        setPending({ step: 'db-warning', picked: trimmed });
        return;
      }
    }
    setPending({ step: 'confirm', picked: trimmed });
  };

  const confirmChange = async (picked: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSetDataRoot(picked);
      setPending(null);
      setRelaunchRequired(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the new data root.');
    } finally {
      setBusy(false);
    }
  };

  const changeOperatorHome = async (operatorId: string) => {
    setError(null);
    let picked: string | null = null;
    try {
      picked = await onPickDirectory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the directory picker.');
      return;
    }
    if (picked === null) return;
    const trimmed = picked.trim();
    if (trimmed.length === 0) return;
    onSetOperatorHome(operatorId, trimmed);
    setRelaunchRequired(true);
  };

  return (
    <SettingsSection title="Storage">
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-[12.5px]">{rootInfo.rootLabel}</span>
            <Badge variant="muted">{dataRoot.source}</Badge>
            <Badge variant={rootInfo.badgeVariant}>{rootInfo.statusLabel}</Badge>
          </span>
        }
        description={
          rootInfo.detail !== null
            ? rootInfo.detail
            : 'Where Ace keeps its database, agent homes, and worktrees.'
        }
        action={
          pending === null ? (
            <ActionButton onClick={() => void startChange()} disabled={busy}>
              Change…
            </ActionButton>
          ) : undefined
        }
      />

      {pending?.step === 'db-warning' && (
        <DbWarningRow
          picked={pending.picked}
          onContinue={() => setPending({ step: 'confirm', picked: pending.picked })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.step === 'confirm' && (
        <ConfirmRow
          currentRoot={dataRoot.root}
          picked={pending.picked}
          busy={busy}
          onConfirm={() => void confirmChange(pending.picked)}
          onCancel={() => setPending(null)}
        />
      )}

      {error !== null && (
        <SettingsRow title="Something went wrong" description={<span className="text-rose-300">{error}</span>} />
      )}

      {relaunchRequired && (
        <SettingsRow
          title="Relaunch required"
          description={RELAUNCH_REQUIRED_NOTICE}
        />
      )}

      <SettingsSection title="Agent data locations">
        {operators.length === 0 ? (
          <SettingsRow
            title="No agents configured"
            description="Agent home folders appear here once operators are set up."
          />
        ) : (
          operators.map((op) => (
            <SettingsRow
              key={op.id}
              icon={<span className="text-base leading-none">{op.emoji}</span>}
              title={op.label}
              description={
                <span className="font-mono text-[11px]">{describeOperatorHome(op)}</span>
              }
              action={
                <ActionButton onClick={() => void changeOperatorHome(op.id)}>
                  Change…
                </ActionButton>
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsSection>
  );
}

function DbWarningRow({
  picked,
  onContinue,
  onCancel,
}: {
  picked: string;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <SettingsRow
      title="Existing dataset found"
      description={
        <>
          <span className="block font-mono text-[11px]">{picked}</span>
          <span className="text-amber-300">{DB_WARNING_COPY}</span>
        </>
      }
      action={
        <span className="flex items-center gap-2">
          <ActionButton onClick={onCancel}>Cancel</ActionButton>
          <ActionButton variant="danger" onClick={onContinue}>
            Continue
          </ActionButton>
        </span>
      }
    />
  );
}

function ConfirmRow({
  currentRoot,
  picked,
  busy,
  onConfirm,
  onCancel,
}: {
  currentRoot: string | null;
  picked: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = buildChangeRootConfirmation({
    currentRoot,
    pickedRoot: picked,
    destinationHasDb: false,
  });
  return (
    <SettingsRow
      title={copy.title}
      description={
        <>
          {copy.warningLines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </>
      }
      action={
        <span className="flex items-center gap-2">
          <ActionButton onClick={onCancel} disabled={busy}>
            Cancel
          </ActionButton>
          <ActionButton variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Saving…' : copy.confirmLabel}
          </ActionButton>
        </span>
      }
    />
  );
}
