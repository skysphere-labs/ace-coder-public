import type { TranscriptEntry, StreamState } from '../../../lib/ace-api';
import {
  AgentEntry,
  ApprovalEntry,
  CommunicationEntry,
  ReasoningEntry,
  SystemEntry,
  ToolEntry,
  UserEntry,
} from './Entries';

type RenderableTranscriptEntry = TranscriptEntry & {
  startedAt?: number;
  tokenCount?: number;
};

export function renderEntry(
  entry: RenderableTranscriptEntry,
  streamId: string,
  streamState: StreamState,
  agentLabel?: string | null
) {
  if (entry.role === 'user') return <UserEntry key={entry.id} text={entry.text} />;
  if (entry.role === 'agent')
    return (
      <AgentEntry
        key={entry.id}
        text={entry.text}
        lifecycle={entry.lifecycle}
        agentLabel={agentLabel}
        tokens={entry.tokenCount}
        startedAt={entry.startedAt}
      />
    );
  if (entry.role === 'reasoning')
    return (
      <ReasoningEntry
        key={entry.id}
        text={entry.text}
        subject={entry.subject}
        lifecycle={entry.lifecycle}
        agentLabel={agentLabel}
        tokens={entry.tokenCount}
        startedAt={entry.startedAt}
        endedAt={entry.tAt}
      />
    );
  if (entry.role === 'communication')
    return (
      <CommunicationEntry
        key={entry.id}
        direction={entry.direction}
        command={entry.command}
        body={entry.body}
        peerLabel={entry.peerLabel}
        peerAgent={entry.peerAgent}
        peerStreamId={entry.peerStreamId}
        redacted={entry.redacted}
        truncated={entry.truncated}
      />
    );
  if (entry.role === 'system')
    return <SystemEntry key={entry.id} subtype={entry.subtype} text={entry.text} />;
  if (entry.role === 'tool')
    return (
      <ToolEntry
        key={entry.id}
        name={entry.name}
        args={entry.args}
        result={entry.result}
        status={entry.status}
        lifecycle={entry.lifecycle}
      />
    );
  if (entry.role === 'approval')
    return (
      <ApprovalEntry
        key={entry.id}
        streamId={streamId}
        prompt={entry.prompt}
        context={entry.context}
        status={entry.status}
        streamState={streamState}
      />
    );
  return null;
}
