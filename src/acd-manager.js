const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fx = require('fs-extra');
const sha256 = require('./utils/sha256.js');
const path = require('path');

class AcdManager {
  constructor(opts) {
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      stasisAppManager: opts.stasisAppManager,
    };
    this.opts.logger.info('    > AcdManager is initialized.');
    this.distributionQueue = [];
    setTimeout(() => {
      this.acdRoutine();
    }, 5000);
  }

  async obtainAgents() {
    const agents = await this.opts.stasisAppManager.ari.endpoints.listByTech({ tech: 'PJSIP' });
    return agents;
  }

  async pickOneAgent() {
    const agents = await this.opts.stasisAppManager.ari.endpoints.listByTech({ tech: 'PJSIP' });
    const availableAgents = agents.filter((a) => !a.resource.includes('trunk') && a.state === 'online' && a.channel_ids.length === 0);
    const randomNo = Math.floor(Math.random() * availableAgents.length - 0.01);
    return availableAgents[randomNo];
  }

  async acdRoutine() {
    this.opts.logger.debug('  [ACD] ACD Routine start.');

    while (true) {
      await new Promise(res => setTimeout(res, 800));

      // Check the queue
      if (this.distributionQueue.length === 0) {
        await new Promise(res => setTimeout(res, 2000));
        continue;
      }


    }
  }


}

module.exports = AcdManager;
