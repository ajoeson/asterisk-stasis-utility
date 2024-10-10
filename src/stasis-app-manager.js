const AriClient = require('ari-client');
const moment = require('moment');
const EventEmitter = require('events').EventEmitter;
const TtsAzure = require('./tts-azure.js');
const Fastify = require("fastify");
const fx = require('fs-extra');
const fs = require('fs');
const path = require('path');

class StasisAppManager extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      ariUrl: opts.ariUrl || 'http://127.0.0.1:8088',
      ariUsername: opts.ariUsername || 'tester',
      ariPassword: opts.ariPassword || '123456',
      stasisAppName: opts.stasisAppName || 'TestStasisApp',
      fastifyPublicDomain: opts.fastifyPublicDomain || 'http://127.0.0.1',
      fastifyPort: opts.fastifyPort || 3015,
      callDefaultLanguage: opts.callDefaultLanguage || 'zh-HK',
    };
    this.callMetaStore = {};
    this.channelStore = {};
    this.localStore = {};
    this.ttsAzure = null;
  }


  // Call Setup Functions

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
      const appParams = channel.dialplan.app_data;
      const appParamsSplit = appParams.split(',');
      const appParamObj = {};
      for (let a = 1; a < appParamsSplit.length; a += 2) {
        appParamObj[appParamsSplit[a]] = appParamsSplit[a + 1];
      }
      const callMetaData = {
        asterisk: {
          channelId: channel.id,
          channelName: channel.name,
          protocolId: channel.protocol_id,
        },
        caller: channel.caller,
        dialplan: channel.dialplan,
        params: appParamObj,
        calledAt: moment(channel.creationtime).local().format('YYYY-MM-DD HH:mm:ss.SSS'),
      };
      this.callMetaStore[channel.id] = callMetaData;
      this.localStore[channel.id] = {};
      this.channelStore[channel.id] = channel;
      this.setLocalVariable(channel.id, 'language', this.opts.callDefaultLanguage);
      channel.removeAllListeners('ChannelDtmfReceived');
      this.emit('newCall', event, channel, callMetaData);

      channel.on('StasisEnd', (evt, chn) => {
        this.opts.logger.info('    > Call is ended.');
        // Delayed Kill
        setTimeout(() => {
          this.opts.logger.info('    > Delay delete metadata.');
          delete this.localStore[chn.id];
          delete this.callMetaStore[chn.id];
          delete this.channelStore[chn.id];
        }, 15000);
      });
    });

    // Setup fastify http server
    fx.ensureDirSync('./tts');
    this.fastify = Fastify();
    this.fastify.get('/aststasisutil/tts/:ttsNodeId/:fileId', (req, res) => {
      const { ttsNodeId, fileId } = req.params;
      this.opts.logger.debug('   > Requested tts file', ttsNodeId, '/', fileId);
      const filePath = path.join(process.cwd(), 'tts', ttsNodeId, fileId);
      if (!fs.existsSync(filePath)) {
        this.opts.logger.error('    > Cannot find tts file at', ttsNodeId, '/', fileId);
        return {};
      }
      this.opts.logger.debug('   > Serving tts file', ttsNodeId, '/', fileId);
      return fs.createReadStream(filePath);
    });
    await this.fastify.listen({ host: '0.0.0.0', port: this.opts.fastifyPort });
    this.opts.logger.info('    > Fastify web server is serving at port', this.opts.fastifyPort);
  }


  // Call Store Functions
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






  // IVR Action Functions
  async ivr_exitApplication(channelId, { continueDialplan = true }) {
    if (continueDialplan) {
      await this.ari.channels.continueInDialplan({ channelId });;
    } else {
      const channel = this.channelStore[channelId];
      channel.hangup();
    }
  }
  async ivr_stopPlayback(channelId) {
    if (this.localStore[channelId].__playbackId) {
      await this.ari.playbacks.stop({ playbackId: this.localStore[channelId].__playbackId }).catch(ex => {
        this.opts.logger.error('      > Cannot stop playback.', this.localStore[channelId].__playbackId, ex.message);
      });
    }
  }
  async ivr_speakText(channelId, { languageOverride, text, mulngtexts, ttsNodeId, setNodeId, checkNodeId }) {
    if (checkNodeId) {
      const nid = this.getLocalVariable(channelId, 'currentTtsNodeId');
      if (nid !== ttsNodeId) {
        this.opts.logger.error('    > tts node id is not sync.', `ttsNodeId=${ttsNodeId}, nid=${nid}`);
        return false;
      }
    }
    if (setNodeId) {
      this.setLocalVariable(channelId, 'currentTtsNodeId', ttsNodeId);
    }
    await this.ivr_stopPlayback(channelId);
    const language = languageOverride || this.getLocalVariable(channelId, 'language') || this.opts.callDefaultLanguage;
    const textContent = mulngtexts ? (mulngtexts[language] || text) : text;
    const ttsCacheObject = await this.ttsAzure.getTtsFile({ language, ttsNodeId, text: textContent });
    await new Promise((resolve) => {
      this.ari.channels.play({
        media: `sound:${this.opts.fastifyPublicDomain}${ttsCacheObject.path}`,
        channelId: channelId,
      }, async (err, playback) => {
        if (err) {
          this.opts.logger.error('    > Error on Asterisk Playback', err.message);
          return resolve({
            completed: false,
            error: err.message
          })
        }
        this.localStore[channelId].__playbackId = playback.id;
        playback.once('PlaybackFinished', (event, instance) => {
          this.localStore[channelId].__playbackId = null;
          resolve({
            completed: true
          });
        });

      });
    });
  }
  ivr_enableUserInput(channelId, { type = ['dtmf'], multiDigits = false, fixLengthDigitInput = false, digitLength, multiDigitsMaxInterval = 2000, nextStepEvtName }) {
    if (type.includes('dtmf')) {
      const channel = this.channelStore[channelId];
      channel.removeAllListeners('ChannelDtmfReceived');

      if (multiDigits) {
        let accumDigits = '';
        let tmo = null;

        const delegateListener = (evt) => {
          if (tmo) {
            clearInterval(tmo);
          }
          accumDigits += evt.digit;

          tmo = setTimeout(async () => {
            channel.removeAllListeners('ChannelDtmfReceived');
            const data = {
              type: evt.type,
              digit: accumDigits,
              multiDigits: true,
              multiDigitsMaxInterval: multiDigitsMaxInterval,
            };
            this.emit(nextStepEvtName, data, channel, this.callMetaStore[channelId]);
          }, multiDigitsMaxInterval);
        };

        channel.on('ChannelDtmfReceived', delegateListener);
      } else if (fixLengthDigitInput) {
        let accumDigits = '';
        const delegateListener = (evt) => {
          accumDigits += evt.digit;
          if (accumDigits.length === digitLength) {
            channel.removeAllListeners('ChannelDtmfReceived');
            const data = {
              type: evt.type,
              digit: accumDigits,
              fixLengthDigitInput: true,
              digitLength: digitLength,
            };
            this.emit(nextStepEvtName, data, channel, this.callMetaStore[channelId]);
          }
        };
        channel.on('ChannelDtmfReceived', delegateListener);
      } else {
        channel.on('ChannelDtmfReceived', async (evt) => {
          channel.removeAllListeners('ChannelDtmfReceived');
          const data = {
            type: evt.type,
            digit: evt.digit,
          };
          this.emit(nextStepEvtName, data, channel, this.callMetaStore[channelId]);
        });
      }
    }
  }









  // Call Action -> Dial Out Feature Funcrtions
  async call_createBridgeForCaller(channelId) {
    const channel = this.channelStore[channelId];
    if (!channel) {
      this.opts.logger.error('        > call_createBridgeForCaller The channel is not found.');
      return false;
    }
    const bridgeId = this.getLocalVariable(channelId, 'callerBridgeId');
    if (bridgeId) {
      this.opts.logger.error('        > call_createBridgeForCaller The channel is in bridge already.');
      return false;
    }
    const callBridge = await this.ari.bridges.create();
    this.setLocalVariable(channelId, 'callerBridgeId', callBridge.id);
    await this.ari.bridges.addChannel({ bridgeId: callBridge.id, channel: channel.id });
    await this.ari.bridges.startMoh({ bridgeId: callBridge.id });
  }
  async call_connectCallerToAgent(channelId, { agent, metadata, onReassign }) {
    const channel = this.channelStore[channelId];
    if (!channel) {
      this.opts.logger.error('        > call_connectCallerToAgent The channel is not found.');
      return false;
    }
    const bridgeId = this.getLocalVariable(channelId, 'callerBridgeId');
    const agentChannel = await this.ari.channels.originate({
      app: 'SimpleCallCenter_JoesonTest',
      appArgs: ['newCallIgnore', 'true'].join(','),
      callerId: metadata.caller.number,
      endpoint: `${agent.technology}/${agent.resource}`,
      variables: {}, timeout: 60,
    });
    agentChannel.on('ChannelDestroyed', async () => {
      if (onReassign) {
        onReassign(channelId);
      }
      agentChannel.hangup().catch(ex => {
        this.opts.logger.debug('      # Failed to hangup call.', ex.message);
      });
    });
    agentChannel.on('StasisStart', async () => {
      agentChannel.removeAllListeners('ChannelDestroyed');
      await this.ari.bridges.stopMoh({ bridgeId: bridgeId });
      this.setLocalVariable(channelId, 'connectedAgentChannelId', agentChannel.id);
      this.ari.bridges.addChannel({ bridgeId: bridgeId, channel: agentChannel.id });
    });

    // Auto Set hangup customer if agent hangup
    agentChannel.on('StasisEnd', async () => {
      await this.call_hangupChannel(channelId);
    });
  }
  async call_hangupChannel(channelId) {
    await this.ari.channels.hangup({ channelId }).catch(ex => {
      this.opts.logger.debug('      # Failed to hangup call.', ex.message);
    });
  }
}

module.exports = StasisAppManager;
