// Cross-process ownership ledger for Hermes dashboard sidecars.
//
// The ledger is one JSON file shared by every Ace main process. Every
// read-modify-write runs under one filesystem lock; per-entry locks are not
// sufficient because two different keys still rewrite the same JSON object.
// Persisted child PIDs are never signaled without a matching process identity,
// so PID reuse cannot terminate an unrelated process.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LEASE_VERSION = 1;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProcessAlive(pid: any) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function defaultTerminateProcess(pid: any, signal: any = 'SIGTERM') {
  process.kill(Number(pid), signal);
}

function defaultProcessIdentity(pid: any, deps: any = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  const execProcess = deps.execFileSync ?? execFileSync;
  const fsForProbe = deps.fsImpl ?? fs;
  try {
    let output = '';
    if (platform === 'win32') {
      const command = [
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${numericPid}\"`,
        'if ($null -eq $p) { exit 3 }',
        '$p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ].join('; ');
      output = execProcess(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: 2_500, maxBuffer: 128 * 1024, windowsHide: true }
      ).trim();
    } else {
      const psPath = fsForProbe.existsSync('/bin/ps') ? '/bin/ps' : 'ps';
      output = execProcess(
        psPath,
        ['-p', String(numericPid), '-o', 'lstart=', '-o', 'command='],
        { encoding: 'utf8', timeout: 1_500, maxBuffer: 128 * 1024 }
      ).trim();
    }
    if (!output) return null;
    return crypto.createHash('sha256').update(output).digest('hex');
  } catch {
    return null;
  }
}

function parseLockParticipant(fsImpl: any, participantPath: string, kind: string) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(participantPath, 'utf8'));
    if (
      parsed?.version === LEASE_VERSION &&
      Number.isInteger(Number(parsed.pid)) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token &&
      parsed.kind === kind &&
      (kind !== 'ticket' || (Number.isSafeInteger(Number(parsed.ticket)) && Number(parsed.ticket) > 0))
    ) {
      return { ...parsed, path: participantPath };
    }
  } catch {}
  return null;
}

function createSidecarLeaseLedger({
  filePath,
  parentPid = process.pid,
  fsImpl = fs,
  processAlive = defaultProcessAlive,
  processIdentity = defaultProcessIdentity,
  terminateProcess = defaultTerminateProcess,
  waitImpl = wait,
  now = () => Date.now(),
  lockRetryMs = 25,
  lockTimeoutMs = 7_000,
  invalidParticipantStaleMs = 60_000,
  afterChoosingWrite = null,
  beforeStaleClaimRemoval = null,
  beforeLockRelease = null,
}: any) {
  if (!filePath) throw new Error('Hermes sidecar lease file path is required');
  const leasePath = path.resolve(String(filePath));
  const numericParentPid = Number(parentPid);
  if (!Number.isInteger(numericParentPid) || numericParentPid <= 0) {
    throw new Error('Hermes sidecar owner pid is invalid');
  }

  const lockPath = `${leasePath}.lock`;
  const parentIdentity = processIdentity(numericParentPid);
  let mutationTail = Promise.resolve();

  function readEntries() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(leasePath, 'utf8'));
      return parsed && parsed.version === LEASE_VERSION && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : {};
    } catch {
      return {};
    }
  }

  function writeEntries(entries: any) {
    if (Object.keys(entries).length === 0) {
      try { fsImpl.unlinkSync(leasePath); } catch {}
      return;
    }
    const dir = path.dirname(leasePath);
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${leasePath}.${numericParentPid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fsImpl.writeFileSync(
        tmp,
        `${JSON.stringify({ version: LEASE_VERSION, entries }, null, 2)}\n`,
        { mode: 0o600 }
      );
      fsImpl.renameSync(tmp, leasePath);
    } catch (err) {
      try { fsImpl.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  function participantIsLive(participant: any) {
    const pid = Number(participant?.pid);
    if (!pid || !processAlive(pid)) return false;
    const expected = typeof participant?.identity === 'string' && participant.identity
      ? participant.identity
      : null;
    const current = processIdentity(pid);
    // An alive PID with incomplete identity metadata is not safe to reap. A
    // verifiable mismatch means the PID was reused and this unique claim is
    // stale; removing that claim can never touch a replacement claim path.
    if (!expected || !current) return true;
    return expected === current;
  }

  function scanParticipants() {
    const participants: any[] = [];
    const invalid: any[] = [];
    let names: string[] = [];
    try { names = fsImpl.readdirSync(lockPath); } catch {}
    for (const name of names) {
      const match = /^claim-([a-f0-9]+)\.(choosing|ticket)$/.exec(name);
      if (!match) continue;
      const participantPath = path.join(lockPath, name);
      const parsed = parseLockParticipant(fsImpl, participantPath, match[2]);
      if (parsed && parsed.token === match[1]) participants.push(parsed);
      else invalid.push({ path: participantPath });
    }
    return { invalid, participants };
  }

  async function removeStaleParticipant(participant: any) {
    if (typeof beforeStaleClaimRemoval === 'function') {
      await beforeStaleClaimRemoval({
        claimPath: participant.path,
        lockPath,
        participant,
      });
    }
    // Claims are immutable and token-named. A replacement necessarily has a
    // different path, so unlinking this exact stale claim is fully fenced.
    try { fsImpl.unlinkSync(participant.path); } catch {}
  }

  async function reapStaleParticipants(ownToken: string) {
    const scanned = scanParticipants();
    for (const invalid of scanned.invalid) {
      let ageMs = 0;
      try { ageMs = Math.max(0, now() - Number(fsImpl.statSync(invalid.path).mtimeMs || 0)); } catch {}
      if (ageMs >= invalidParticipantStaleMs) {
        try { fsImpl.unlinkSync(invalid.path); } catch {}
      }
    }
    for (const participant of scanned.participants) {
      if (participant.token !== ownToken && !participantIsLive(participant)) {
        await removeStaleParticipant(participant);
      }
    }
  }

  async function acquireLock() {
    const deadline = now() + lockTimeoutMs;
    const token = crypto.randomBytes(18).toString('hex');
    const choosingPath = path.join(lockPath, `claim-${token}.choosing`);
    const ticketPath = path.join(lockPath, `claim-${token}.ticket`);
    const owner = {
      version: LEASE_VERSION,
      pid: numericParentPid,
      identity: parentIdentity,
      token,
      createdAt: now(),
    };
    let choosingWritten = false;
    let ticketWritten = false;
    let ticket = 0;
    fsImpl.mkdirSync(lockPath, { recursive: true });

    try {
      fsImpl.writeFileSync(
        choosingPath,
        JSON.stringify({ ...owner, kind: 'choosing' }),
        { mode: 0o600, flag: 'wx' }
      );
      choosingWritten = true;
      if (typeof afterChoosingWrite === 'function') {
        await afterChoosingWrite({ claimPath: choosingPath, lockPath, token });
      }

      await reapStaleParticipants(token);
      const liveTickets = scanParticipants().participants.filter((participant: any) => (
        participant.kind === 'ticket' && participant.token !== token && participantIsLive(participant)
      ));
      const maxTicket = liveTickets.reduce(
        (highest: number, participant: any) => Math.max(highest, Number(participant.ticket) || 0),
        0
      );
      if (maxTicket >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Hermes sidecar ledger lock ticket space is exhausted');
      }
      ticket = maxTicket + 1;
      fsImpl.writeFileSync(
        ticketPath,
        JSON.stringify({ ...owner, kind: 'ticket', ticket }),
        { mode: 0o600, flag: 'wx' }
      );
      ticketWritten = true;
      try { fsImpl.unlinkSync(choosingPath); } catch {}
      choosingWritten = false;

      while (true) {
        await reapStaleParticipants(token);
        const scanned = scanParticipants();
        let blocked = scanned.invalid.length > 0;
        for (const participant of scanned.participants) {
          if (participant.token === token) continue;
          if (!participantIsLive(participant)) {
            await removeStaleParticipant(participant);
            continue;
          }
          if (participant.kind === 'choosing') {
            blocked = true;
            continue;
          }
          const precedes = Number(participant.ticket) < ticket || (
            Number(participant.ticket) === ticket && String(participant.token) < token
          );
          if (precedes) blocked = true;
        }
        if (!blocked) {
          return async () => {
            if (typeof beforeLockRelease === 'function') {
              await beforeLockRelease({ claimPath: ticketPath, lockPath, ticket, token });
            }
            // Release removes only this immutable, token-named claim. It never
            // recursively removes the shared directory or another generation.
            try { fsImpl.unlinkSync(ticketPath); } catch {}
          };
        }
        if (now() >= deadline) {
          throw new Error('timed out waiting for Hermes sidecar ledger lock');
        }
        await waitImpl(lockRetryMs);
      }
    } catch (err) {
      if (choosingWritten) { try { fsImpl.unlinkSync(choosingPath); } catch {} }
      if (ticketWritten) { try { fsImpl.unlinkSync(ticketPath); } catch {} }
      throw err;
    }
  }

  function withLedgerLock(fn: any) {
    const task = mutationTail
      .catch(() => {})
      .then(async () => {
        const release = await acquireLock();
        try {
          return await fn();
        } finally {
          await release();
        }
      });
    mutationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  function currentIdentity(pid: number) {
    try { return processIdentity(pid); } catch { return null; }
  }

  async function waitForExpectedProcessExit(pid: number, expectedIdentity: string, timeoutMs: number) {
    const deadline = now() + timeoutMs;
    while (processAlive(pid) && now() < deadline) {
      const current = currentIdentity(pid);
      if (current && current !== expectedIdentity) return true;
      await waitImpl(25);
    }
    if (!processAlive(pid)) return true;
    const current = currentIdentity(pid);
    return Boolean(current && current !== expectedIdentity);
  }

  async function reserve(seed: any) {
    return withLedgerLock(async () => {
      const entries = readEntries();
      const key = String(seed?.key || '');
      if (!key) throw new Error('Hermes sidecar lease key is required');
      const lease = entries[key];
      const ownerPid = Number(lease?.ownerPid);
      if (ownerPid > 0 && ownerPid !== numericParentPid && processAlive(ownerPid)) {
        const expectedOwnerIdentity = lease?.ownerIdentity || null;
        const observedOwnerIdentity = currentIdentity(ownerPid);
        if (!expectedOwnerIdentity || !observedOwnerIdentity || expectedOwnerIdentity === observedOwnerIdentity) {
          throw new Error(`Hermes dashboard is owned by another running Ace process (${ownerPid})`);
        }
      }

      const childPid = Number(lease?.childPid);
      if (childPid > 0 && processAlive(childPid)) {
        const expectedChildIdentity = typeof lease?.childIdentity === 'string' && lease.childIdentity
          ? lease.childIdentity
          : null;
        const observedChildIdentity = currentIdentity(childPid);
        if (!expectedChildIdentity || !observedChildIdentity) {
          throw new Error(`cannot verify persisted Hermes dashboard process ${childPid}; refusing to signal it`);
        }
        if (observedChildIdentity === expectedChildIdentity) {
          try {
            terminateProcess(childPid, 'SIGTERM');
          } catch (err: any) {
            throw new Error(`failed to stop orphaned Hermes dashboard ${childPid}: ${err?.message || err}`);
          }
          if (!(await waitForExpectedProcessExit(childPid, expectedChildIdentity, 5_000))) {
            const beforeKillIdentity = currentIdentity(childPid);
            if (!beforeKillIdentity) {
              throw new Error(`cannot verify persisted Hermes dashboard process ${childPid}; refusing to SIGKILL it`);
            }
            if (beforeKillIdentity === expectedChildIdentity) {
              try { terminateProcess(childPid, 'SIGKILL'); } catch {}
            }
            if (!(await waitForExpectedProcessExit(childPid, expectedChildIdentity, 1_000))) {
              throw new Error(`orphaned Hermes dashboard ${childPid} did not exit`);
            }
          }
        }
      }

      entries[key] = {
        version: LEASE_VERSION,
        ownerPid: numericParentPid,
        ownerIdentity: parentIdentity,
        childPid: null,
        childIdentity: null,
        kind: seed?.kind ?? 'home',
        home: seed?.home ?? null,
        host: null,
        port: null,
        startedAt: now(),
      };
      writeEntries(entries);
    });
  }

  async function record(lease: any) {
    return withLedgerLock(async () => {
      const key = String(lease?.key || '');
      const childPid = Number(lease?.childPid);
      const childIdentity = lease?.childIdentity || currentIdentity(childPid);
      if (!key) throw new Error('Hermes sidecar lease key is required');
      if (!Number.isInteger(childPid) || childPid <= 0) {
        throw new Error('Hermes dashboard spawn did not return a process id');
      }
      if (!childIdentity) {
        throw new Error(`could not capture Hermes dashboard process identity for ${childPid}`);
      }
      const entries = readEntries();
      entries[key] = {
        version: LEASE_VERSION,
        ownerPid: numericParentPid,
        ownerIdentity: parentIdentity,
        childPid,
        childIdentity,
        kind: lease?.kind ?? 'home',
        home: lease?.home ?? null,
        host: lease?.host ?? null,
        port: lease?.port ?? null,
        startedAt: lease?.startedAt ?? now(),
      };
      writeEntries(entries);
      return entries[key];
    });
  }

  async function clear(match: any) {
    return withLedgerLock(async () => {
      const entries = readEntries();
      const key = String(match?.key || '');
      const lease = entries[key];
      if (!lease) return false;
      if (match?.childPid != null) {
        if (Number(lease.childPid) !== Number(match.childPid)) return false;
        if (match?.childIdentity && lease.childIdentity !== match.childIdentity) return false;
      } else if (
        Number(lease.ownerPid) !== numericParentPid ||
        (parentIdentity && lease.ownerIdentity && lease.ownerIdentity !== parentIdentity) ||
        lease.childPid != null
      ) {
        return false;
      }
      delete entries[key];
      writeEntries(entries);
      return true;
    });
  }

  return {
    clear,
    record,
    reserve,
    snapshot: () => readEntries(),
  };
}

module.exports = {
  createSidecarLeaseLedger,
  defaultProcessAlive,
  defaultProcessIdentity,
  defaultTerminateProcess,
};
