const AriClient = require('ari-client');
const moment = require('moment');
const EventEmitter = require('events').EventEmitter;
const TtsAzure = require('./tts-azure.js');
const Fastify = require("fastify");
const fx = require('fs-extra');

class StasisAppManager extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      ariUrl: opts.ariUrl || 'http://127.0.0.1:8088',
      ariUsername: opts.ariUsername || 'tester',
      ariPassword: opts.ariPassword || '123456',
      stasisAppName: opts.stasisAppName || 'TestStasisApp',
      fastifyPort: opts.fastifyPort || 3015,
    };
    this.callMetaStore = {};
    this.localStore = {};
    this.ttsAzure = null;
  }

  async connect() {
    this.ari = await new Promise((resolve, reject) => {
      AriClient.connect(this.opts.ariUrl, this.opts.ariUsername, this.opts.ariPassword, (err, ari) => {
        if (err) {
          return reject(err);
        }
        this.emit('connected', {});
        resolve(ari);
      });
    });
  }

  setTtsAzureKey(opts) {
    this.ttsAzure = new TtsAzure(opts);
  }

  async serve() {
    this.opts.logger.info('    > Stasis app', this.opts.stasisAppName, 'is serving.');
    await this.ari.start(this.opts.stasisAppName);
    this.ari.on('StasisStart', (event, channel) => {
      const callMetaData = {
        asterisk: {
          channelId: channel.id,
          channelName: channel.name,
          protocolId: channel.protocol_id,
        },
        caller: channel.caller,
        dialplan: channel.dialplan,
        calledAt: moment(channel.creationtime).local().format('YYYY-MM-DD HH:mm:ss.SSS'),
      };
      this.callMetaStore[channel.id] = callMetaData;
      this.localStore[channel.id] = {};
      this.emit('newCall', event, channel, callMetaData);

      channel.on('StasisEnd', (evt, chn) => {
        this.opts.logger.info('    > Call is ended.');
        delete this.localStore[chn.id];
        delete this.callMetaStore[chn.id];
      });
    });

    // Setup fastify http server
    fx.ensureDirSync('./tts');
    this.fastify = Fastify();
    this.fastify.post('/aststasisutil/tts/:ttsNodeId/:fileId', async (req, res) => {
      return {};
    });
    await this.fastify.listen({ host: '0.0.0.0', port: this.opts.fastifyPort });
    this.opts.logger.info('    > Fastify web server is serving at port', this.opts.fastifyPort);
  }

  setLocalVariable(channelId, key, val) {
    if (!this.localStore[channelId]) {
      return false;
    }
    this.localStore[channelId][key] = val;
    this.ari.channels.setChannelVar({ channelId: channelId, variable: key, value: val });
    return true;
  }

  getLocalVariable(channelId, key) {
    if (!this.localStore[channelId]) {
      return;
    }
    return this.localStore[channelId][key];
  }

  async getAsteriskChannelVariable(channelId, key) {
    return await this.ari.channels.getChannelVar({ channelId: channelId, variable: key });
  }

}

module.exports = StasisAppManager;
