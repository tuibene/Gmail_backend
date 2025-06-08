const mongoose = require('mongoose');

const labelSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  isSystemLabel: { type: Boolean, default: false }, // New field to mark system labels like "Spam"
  createdAt: { type: Date, default: Date.now }
});

// Static method to ensure a Spam label exists for a user
labelSchema.statics.ensureSpamLabel = async function (userId) {
  const spamLabel = await this.findOne({ userId, name: 'Spam', isSystemLabel: true });
  if (!spamLabel) {
    const newSpamLabel = new this({
      userId,
      name: 'Spam',
      isSystemLabel: true,
      createdAt: new Date()
    });
    await newSpamLabel.save();
    return newSpamLabel;
  }
  return spamLabel;
};

module.exports = mongoose.model('Label', labelSchema);