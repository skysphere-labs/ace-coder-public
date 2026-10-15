// Props-driven Operators section (read-mostly). No IPC here — a later
// integration unit mounts this inside PreferencesScreen and wires the
// operator list/actions through.

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Badge } from '../ui/badge';
import { ActionButton, SettingsRow, SettingsSection } from './primitives';
import { describeOperatorHome, type OperatorLike } from './storage-section-logic';

export function OperatorsSection({
  operators,
  onRename,
  onSetOperatorHome,
}: {
  operators: OperatorLike[];
  onRename: (id: string, label: string) => void;
  onSetOperatorHome: (id: string, path: string) => void;
}) {
  return (
    <SettingsSection title="Operators">
      {operators.length === 0 ? (
        <SettingsRow
          title="No operators configured"
          description="Operators appear here once agent profiles are set up."
        />
      ) : (
        operators.map((op) => (
          <OperatorRow
            key={op.id}
            operator={op}
            onRename={onRename}
            onSetOperatorHome={onSetOperatorHome}
          />
        ))
      )}
    </SettingsSection>
  );
}

function OperatorRow({
  operator,
  onRename,
  onSetOperatorHome,
}: {
  operator: OperatorLike;
  onRename: (id: string, label: string) => void;
  onSetOperatorHome: (id: string, path: string) => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(operator.label);
  const [editingHome, setEditingHome] = useState(false);
  const [homeDraft, setHomeDraft] = useState(operator.hermesHome ?? '');

  const saveLabel = () => {
    const trimmed = labelDraft.trim();
    if (trimmed.length > 0 && trimmed !== operator.label) {
      onRename(operator.id, trimmed);
    }
    setEditingLabel(false);
  };

  const saveHome = () => {
    const trimmed = homeDraft.trim();
    if (trimmed.length > 0 && trimmed !== (operator.hermesHome ?? '')) {
      onSetOperatorHome(operator.id, trimmed);
    }
    setEditingHome(false);
  };

  return (
    <SettingsRow
      icon={<span className="text-base leading-none">{operator.emoji}</span>}
      title={
        editingLabel ? (
          <input
            autoFocus
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveLabel();
              if (e.key === 'Escape') {
                setLabelDraft(operator.label);
                setEditingLabel(false);
              }
            }}
            aria-label={`Rename ${operator.label}`}
            className="w-full max-w-[10rem] rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-0.5 text-sm font-medium text-foreground outline-none"
          />
        ) : (
          <span className="flex items-center gap-2">
            <span>{operator.label}</span>
            {operator.isControlPlane && <Badge variant="muted">Control plane</Badge>}
            <button
              type="button"
              onClick={() => {
                setLabelDraft(operator.label);
                setEditingLabel(true);
              }}
              aria-label={`Edit name of ${operator.label}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground sm:h-auto sm:w-auto sm:bg-transparent sm:p-0"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </span>
        )
      }
      description={
        editingHome ? (
          <span className="mt-1 flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
              autoFocus
              value={homeDraft}
              onChange={(e) => setHomeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveHome();
                if (e.key === 'Escape') {
                  setHomeDraft(operator.hermesHome ?? '');
                  setEditingHome(false);
                }
              }}
              placeholder="/absolute/path/to/hermes-home"
              aria-label={`Home folder for ${operator.label}`}
              className="w-full min-w-0 flex-1 rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-0.5 font-mono text-[11px] text-foreground outline-none sm:w-64 sm:max-w-[16rem] sm:flex-none"
            />
            <ActionButton onClick={saveHome}>Save</ActionButton>
            <ActionButton
              onClick={() => {
                setHomeDraft(operator.hermesHome ?? '');
                setEditingHome(false);
              }}
            >
              Cancel
            </ActionButton>
          </span>
        ) : (
          <span className="font-mono text-[11px]">{describeOperatorHome(operator)}</span>
        )
      }
      action={
        !editingHome ? (
          <ActionButton
            onClick={() => {
              setHomeDraft(operator.hermesHome ?? '');
              setEditingHome(true);
            }}
          >
            Change home…
          </ActionButton>
        ) : undefined
      }
    />
  );
}
