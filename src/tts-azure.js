const sdk = require("microsoft-cognitiveservices-speech-sdk");
const fx = require('fs-extra');
const sha256 = require('./utils/sha256.js');
const path = require('path');

class TtsAzure {
  constructor(opts) {
    this.opts = {
      logger: opts.logger || { info: console.log, error: console.error, debug: console.log, warn: console.warn },
      region: opts.region || '',
      subscriptionKey: opts.subscriptionKey || '',
      voiceConfig: opts.voiceConfig || {},
    };
    this.opts.logger.info('    > Tts Azure is initialized.');
  }

  async getTtsFile({ language, ttsNodeId, text }) {
    if (!this.opts.voiceConfig[language]) {
      this.opts.logger.error('    > Cannot find language configuration', language);
    }
    ttsNodeId = ttsNodeId.split('/').join('_');
    const textHash = sha256(text);
    const cacheFolder = path.join(process.cwd(), 'tts', ttsNodeId);
    fx.ensureDirSync(cacheFolder);
    const cacheFilepath = path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.wav');
    if (fx.existsSync(cacheFilepath)) {
      return {
        path: `/aststasisutil/tts/${ttsNodeId}/${textHash}.wav`,
        filename: textHash + '.wav',
        filePath: path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.wav'),
      };
    }

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(cacheFilepath);
    const speechConfig = sdk.SpeechConfig.fromSubscription(this.opts.subscriptionKey, this.opts.region);
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff8Khz16BitMonoPcm;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);
    const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xmlns:emo="http://www.w3.org/2009/10/emotionml" version="1.0" xml:lang="${language}">
<voice name="${this.opts.voiceConfig[language].voice}">
<prosody rate="${this.opts.voiceConfig[language].speed}" pitch="${this.opts.voiceConfig[language].pitch}">${text}</prosody>
</voice>
</speak>`;

    await new Promise((resolve, reject) => {
      // console.log("ssml", ssml);
      synthesizer.speakSsmlAsync(String(ssml), result => {
        this.opts.logger.info('    > [Azure TTS] Finished TTS Generation');
        synthesizer.close();
        resolve(true);
      }, error => {
        this.opts.logger.error('    > [Azure TTS] TTS Gen error', error.message);
        reject(error);
      });
    });

    return {
      path: `/aststasisutil/tts/${ttsNodeId}/${textHash}.wav`,
      filename: textHash + '.wav',
      filePath: path.join(process.cwd(), 'tts', ttsNodeId, textHash + '.wav'),
    };
  }
}

module.exports = TtsAzure;
