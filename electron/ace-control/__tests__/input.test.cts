const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInput,
  sanitizeTerminalInputPayload,
} = require('../input.cjs');

test('control input drops screenshot-style generated NaN garbage', async () => {
  const writes: any[] = [];
  const input = createInput({
    writeTerminalInput: async (streamId: any, data: any) => {
      writes.push({ streamId, data });
      return { ok: true };
    },
    profileFor: () => ({}),
  });

  assert.equal(sanitizeTerminalInputPayload('aN;NaNMaN;NaNMaN;NaNMa'), null);
  assert.deepEqual(await input.type('conversation:claude', 'aN;NaNMaN;NaNMa'), { ok: false });
  assert.deepEqual(writes, []);
});

test('control input strips generated fragments but keeps human text', async () => {
  const writes: any[] = [];
  const input = createInput({
    writeTerminalInput: async (streamId: any, data: any) => {
      writes.push({ streamId, data });
      return { ok: true };
    },
    profileFor: () => ({}),
  });

  assert.equal(sanitizeTerminalInputPayload('ship itaN;NaNMaN;NaNMa'), 'ship it');
  assert.deepEqual(await input.type('conversation:claude', 'ship itaN;NaNMaN;NaNMa'), { ok: true });
  assert.deepEqual(writes, [{ streamId: 'conversation:claude', data: 'ship it' }]);
});
