'use strict';

// Only explicitly isolated, unpackaged fixtures may change application visibility.
function hiddenTestRun(app, env = process.env) {
  return !app.isPackaged && !!env.MAVIS_TEST_USER_DATA && env.MAVIS_TEST_SHOW_WINDOW !== '1';
}

module.exports = { hiddenTestRun };
