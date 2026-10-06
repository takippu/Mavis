'use strict';
// Install before main: preserve real shell checks while preventing fixture agent CLI launches.
module.exports = ipcMain => {
  const register = ipcMain.handle;
  ipcMain.handle = function(channel, handler) {
    if (channel === 'workspace:terminal') {
      register.call(this, channel, (event, payload) => payload.kind === 'shell' ? handler(event, payload) : { ok: false, reason: 'Agent launch suppressed in this isolated fixture.' });
      ipcMain.handle = register;
    } else register.call(this, channel, handler);
  };
};
