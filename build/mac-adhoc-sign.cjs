// electron-builder afterSign hook: deterministic ad-hoc deep re-sign of the mac bundle.
//
// Why this exists:
// - arm64 macOS refuses to launch an app bundle without a valid signature, and the
//   bundle is modified after electron-builder's own signing pass (asarUnpack content,
//   extendInfo plist edits), so it needs at minimum an ad-hoc re-sign at the end.
// - electron-builder's built-in ad-hoc signing path has a known regression
//   (electron-builder issue #9529), so we set mac.identity to null in package.json to
//   skip it entirely and perform a deterministic `codesign --force --deep` here instead.
// - ACE_MAC_SIGN_IDENTITY is the seam for a real Developer ID later: when set, it
//   is passed to codesign verbatim; otherwise we fall back to '-' (ad-hoc).
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + '.app',
  );
  const identity = process.env.ACE_MAC_SIGN_IDENTITY || '-';

  console.log(
    `[mac-adhoc-sign] codesign --force --deep --sign ${identity === '-' ? '- (ad-hoc)' : identity} ${appPath}`,
  );
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], {
    stdio: 'inherit',
  });

  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log(`[mac-adhoc-sign] verified signature on ${appPath}`);
};
