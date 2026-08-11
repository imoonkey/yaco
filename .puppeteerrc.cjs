/** Puppeteer arrives only as a transitive dependency of `whatsapp-web.js`, the
 *  optional WhatsApp channel. Its post-install would otherwise download ~626 MB
 *  of Chromium into ~/.cache/puppeteer on every clone-install, for a channel
 *  that is off by default.
 *
 *  Switching the channel on needs a browser: `npx puppeteer browsers install
 *  chrome`, or point PUPPETEER_EXECUTABLE_PATH at an existing Chrome.
 *
 *  This file, not app/server/package.json, is where the setting has to live:
 *  puppeteer v24 resolves its config with cosmiconfig walking up from
 *  node_modules/puppeteer, and reads PUPPETEER_SKIP_DOWNLOAD from the
 *  environment — never from npm config. The repo root is the only point on that
 *  walk. */
module.exports = { skipDownload: true }
