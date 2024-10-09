const { createHash } = require('crypto');

module.exports = (text) => {
  return createHash('sha256').update(text).digest('hex');
};
