const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fx = require('fs-extra');
const sha256 = require('./utils/sha256.js');
const path = require('path');

class AcdManager {
  constructor(opts) {
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      
    };
    this.opts.logger.info('    > AcdManager is initialized.');
  }

}

module.exports = AcdManager;
