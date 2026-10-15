const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cliInstaller = require('../cli-installer.cts');

test('repointAceCli repairs executable bit when symlink already targets current bundle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-cli-installer-'));
  const priorHome = process.env.HOME;
  try {
    const home = path.join(tmp, 'home');
    const appRoot = path.join(tmp, 'app');
    const bundled = path.join(appRoot, 'tools', 'ace', 'bin', 'ace');
    const install = path.join(home, '.local', 'bin', 'ace');
    fs.mkdirSync(path.dirname(bundled), { recursive: true });
    fs.mkdirSync(path.dirname(install), { recursive: true });
    fs.writeFileSync(bundled, "#!/usr/bin/env node\nrequire('../src/index.cjs');\n");
    fs.chmodSync(bundled, 0o644);
    fs.symlinkSync(bundled, install);
    process.env.HOME = home;

    const app = { isPackaged: false, getAppPath: () => appRoot };
    const result = cliInstaller.repointAceCli(app);

    assert.equal(result.ok, true);
    assert.equal(fs.statSync(bundled).mode & 0o111, 0o111);
  } finally {
    if (priorHome == null) delete process.env.HOME;
    else process.env.HOME = priorHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
