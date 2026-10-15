export type RemoteResponseEnvelope = {
  ok?: boolean;
  error?: string;
};

// The remote server uses a plain-text 403 when the enrolled device token is
// invalid. Method-level authorization failures use a typed JSON envelope.
// Only the former should erase enrollment; otherwise a desktop-only action
// attempted from the remote UI would unexpectedly sign the whole device out.
export function isRemoteCredentialRejection(
  status: number,
  body: RemoteResponseEnvelope | null
): boolean {
  return status === 403 && !(body?.ok === false && typeof body.error === 'string');
}
