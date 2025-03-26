const AriClient = require('ari-client');
const moment = require('moment');
const EventEmitter = require('events').EventEmitter;
const TtsAzure = require('./tts-azure.js');
const TtsMinimax = require('./tts-minimax.js');
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
      agentDialTimeout: opts.agentDialTimeout || 20,
    };
    this.callMetaStore = {};
    this.channelStore = {};
    this.localStore = {};
    this.ttsEngine = null;
    this.ttsAzure = null;
    this.ttsMinimax = null;
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
    this.ttsEngine = 'Azure';
  }

  setTtsMinimaxKey(opts) {
    this.ttsMinimax = new TtsMinimax(opts);
    this.ttsEngine = 'Minimax';
  }

  async serve({ fastifySetupHook }) {
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
    if (fastifySetupHook) {
      await fastifySetupHook(this.fastify);
    }
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
  async ivr_speakText(channelId, { languageOverride, text, mulngtexts, ttsNodeId, setNodeId, checkNodeId, isLocal = false, state }) {
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
    try {
      const language = languageOverride || this.getLocalVariable(channelId, 'language') || this.opts.callDefaultLanguage;
      const textContent = mulngtexts ? (mulngtexts[language] || text) : text;
      const ttsCacheObject = this.ttsEngine === 'Azure' ?
       await this.ttsAzure.getTtsFile({ language, ttsNodeId, text: textContent }) : 
       await this.ttsMinimax.getTtsFile({ language, ttsNodeId, text: textContent });

      if (state && state.realAnswerStarted) {
        this.opts.logger.warn('        --> Inside ivr_speakText state.realAnswerStarted is true. Skip the intemediate response playback.');
        return;
      }
      
      await this.ivr_stopPlayback(channelId);
      await new Promise((resolve) => {
        let url = `sound:${this.opts.fastifyPublicDomain}${ttsCacheObject.path}`;
        if (isLocal) {
          url = `sound:${ttsCacheObject.filePathWoExt}`;
        }
        try {
          this.ari.channels.play({
            media: url,
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
        } catch (playError) {
          console.error('! -> Play Error', playError.message);
        }
      });
    } catch (ivrSpeakError) {
      console.error('! -> ivrSpeakError', ivrSpeakError.message);
    }
  }
  ivr_processFollowupDueCompletion(channelId, { nextStepEvtName }) {
    const channel = this.channelStore[channelId];
    channel.removeAllListeners('ChannelDtmfReceived');
    const data = {
      type: 'followupDueCompletion',
    };
    this.emit(nextStepEvtName, data, channel, this.callMetaStore[channelId]);
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
  ivr_countdown(channelId, { timeout = 15000, ttsNodeId, onTimeout }) {
    const channel = this.channelStore[channelId];
    if (ttsNodeId) {
      const nid = this.getLocalVariable(channelId, 'currentTtsNodeId');
      if (nid !== ttsNodeId) {
        this.opts.logger.error('    > Check node completed. No countdown is required.', `ttsNodeId=${ttsNodeId}, nid=${nid}`);
        return false;
      }
    }
    const timeoutInt = setTimeout(() => {
      channel.removeListener('ChannelDtmfReceived', delegateListener);
      if (onTimeout) {
        onTimeout();
      } else {
        this.opts.logger.error('    > Timeout triggered but function not found.');
      }
    }, timeout);
    const delegateListener = (evt) => {
      channel.removeListener('ChannelDtmfReceived', delegateListener);
      clearTimeout(timeoutInt);
    };
    channel.on('ChannelDtmfReceived', delegateListener);
  }
  async ivr_recordVoicemail(channelId, { beep = true, timeout = 30, endSignal }) {
    const voicemailFilename = `voicemail-${channelId}-${Date.now()}`;
    let liveRecording = await this.ari.channels.record({
      channelId: channelId,
      format: "wav",
      beep: beep,
      name: voicemailFilename,
      maxDurationSeconds: timeout,
      maxSilenceSeconds: timeout,
      terminateOn: endSignal,
    });
    return await new Promise((res) => {
      liveRecording.once("RecordingFinished", async (e, recording) => {
        this.opts.logger.info("     > [Voicemail] Timeout or silence detected.", voicemailFilename);
        res({
          result: true,
          voicemailFilename: voicemailFilename,
          channelId: channelId,
        });
      });
      liveRecording.once("RecordingFailed", (err) => {
        this.opts.logger.error("     > [IVRASR] Recording Failed", voicemailFilename, err.message);
        res({
          result: false,
          voicemailFilename: voicemailFilename,
          channelId: channelId,
        });
      });
      liveRecording.once("RecordingStarted", (e, recording) => {
        this.opts.logger.info("      > IVRASR] Can record now", voicemailFilename);
      });
    });
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
    const callBridge = await this.ari.bridges.create({ type: 'mixing,dtmf_events' });
    this.setLocalVariable(channelId, 'callerBridgeId', callBridge.id);
    await this.ari.bridges.addChannel({ bridgeId: callBridge.id, channel: channel.id });
    await this.ari.bridges.startMoh({ bridgeId: callBridge.id });
  }
  async call_startMohOnBridge(bridgeId) {
    await this.ari.bridges.startMoh({ bridgeId: bridgeId }).catch(ex => this.opts.logger.error('        > call_startMohOnBridge Failed', ex.message));
  }
  async call_stopMohOnBridge(bridgeId) {
    await this.ari.bridges.stopMoh({ bridgeId: bridgeId }).catch(ex => this.opts.logger.error('        > call_stopMohOnBridge Failed', ex.message));
  }
  async call_connectCallerToAgent(channelId, { agent, metadata, onReassign }) {
    const channel = this.channelStore[channelId];
    if (!channel) {
      this.opts.logger.error('        > call_connectCallerToAgent The channel is not found.');
      return false;
    }
    const bridgeId = this.getLocalVariable(channelId, 'callerBridgeId');
    const agentChannel = await this.ari.channels.originate({
      app: this.opts.stasisAppName,
      appArgs: ['newCallIgnore', 'true', 'callerType', 'Agent'].join(','),
      callerId: metadata.caller.number,
      endpoint: `${agent.technology}/${agent.resource}`,
      variables: {}, timeout: this.opts.agentDialTimeout || 20,
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

    return agentChannel;
  }
  async call_hangupChannel(channelId) {
    await this.ari.channels.hangup({ channelId }).catch(ex => {
      this.opts.logger.debug('      # Failed to hangup call.', ex.message);
    });
  }
}

module.exports = StasisAppManager;
