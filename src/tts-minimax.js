const axios = require("axios").default;
const fx = require('fs-extra');
const sha256 = require('./utils/sha256.js');
const path = require('path');

class TtsMinimax {
  constructor(opts) {
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      apiKey: opts.apiKey || '',
      groupId: opts.groupId || '',
      voiceConfig: opts.voiceConfig || {},
    };
    this.opts.logger.info('    > Tts Minimax is initialized.');
  }

  async getTtsFile({ language, ttsNodeId, text }) {
    if (!this.opts.voiceConfig[language]) {
      this.opts.logger.error('    > Cannot find language configuration', language);
    }
    ttsNodeId = ttsNodeId.split('/').join('_');
    const textHash = sha256(text);
    const cacheFolder = path.join(process.cwd(), 'tts', ttsNodeId);
    fx.ensureDirSync(cacheFolder);
    const cacheFilepath = path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.' + "mp3");
    if (fx.existsSync(cacheFilepath)) {
      return {
        path: `/aststasisutil/tts/${ttsNodeId}/${textHash}.${ "mp3"}`,
        filename: textHash + '.wav',
        filePath: path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.' + "mp3"),
        filePathWoExt: path.join(process.cwd(), 'tts', ttsNodeId, textHash),
      };
    }

    const { data: { data: { audio } } } = await axios.post('https://api.minimaxi.chat/v1/t2a_v2?GroupId=' + this.opts.groupId, {
      "model": "speech-01-turbo",
      "text": text,
      "stream": false,
      "subtitle_enable": false,
      "output_format": "hex",
      "language_boost": language === 'zh-HK' ? "Chinese,Yue" : language === 'zh-CN' ? 'Chinese' : 'English',
      "voice_setting":{
          "voice_id": this.opts.voiceConfig[language].voice || "Deep_Voice_Man",
          "speed": this.opts.voiceConfig[language].speed || 1,
          "vol": this.opts.voiceConfig[language].vol || 1,
          "pitch": this.opts.voiceConfig[language].pitch || 0
      },
      "audio_setting":{
          "sample_rate": this.opts.voiceConfig[language].sampleRate || 8000,
          "bitrate": this.opts.voiceConfig[language].bitrate || 128000,
          "format": "mp3",
          "channel": 1
      }
    }, {
      headers: {
        Authorization: 'Bearer ' + this.opts.apiKey,
      },
    });

    fx.writeFileSync(cacheFilepath, Buffer.from(audio, 'hex'));

    return {
      path: `/aststasisutil/tts/${ttsNodeId}/${textHash}.${ "mp3"}`,
      filename: textHash + '.mp3',
      filePath: path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.' +  "mp3"),
      filePathWoExt: path.join(process.cwd(), 'tts', ttsNodeId, textHash),
    };
  }
}

module.exports = TtsMinimax;
