const mongoose = require('mongoose');

const autoReplySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  enabled: { type: Boolean, default: false },
  message: { type: String, default: 'Thank you for your email. I am currently unavailable and will respond soon.' },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AutoReply', autoReplySchema);