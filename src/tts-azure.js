const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fx = require('fs-extra');

class TtsAzure {
  constructor(opts) {
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      region: opts.region || '',
      subscriptionKey: opts.subscriptionKey || '',
      voiceConfig: opts.voiceConfig || {},
    };
    this.opts.logger.info('    > Tts Azure is initiated.');
  }


}

module.exports = TtsAzure;
