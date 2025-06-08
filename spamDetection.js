const User = require('./models/User');

// Simple rule-based spam detection
async function detectSpam(email, sender) {
  try {
    // Common spam keywords
    const spamKeywords = [
      'win a prize', 'free offer', 'click here', 'urgent', 'limited time offer',
      'make money fast', 'lottery', 'guaranteed', 'viagra', 'cheap pills'
    ];

    // Check for suspicious patterns
    const subject = email.subject.toLowerCase();
    const body = email.body.toLowerCase();

    // 1. Keyword-based detection
    const hasSpamKeyword = spamKeywords.some(keyword => 
      subject.includes(keyword) || body.includes(keyword)
    );
    if (hasSpamKeyword) return true;

    // 2. Excessive links (e.g., more than 5 URLs in body)
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const links = body.match(urlRegex) || [];
    if (links.length > 5) return true;

    // 3. Sender reputation (e.g., check if sender is unverified)
    const senderUser = await User.findOne({ email: sender, isEmailVerified: true });
    if (!senderUser) return true; // Unverified sender is considered spam

    // 4. Excessive recipients (e.g., more than 10 recipients)
    if (email.recipients.length > 10) return true;

    // 5. Suspicious attachments (e.g., large or unusual file types)
    if (email.attachments && email.attachments.length > 0) {
      const hasSuspiciousAttachment = email.attachments.some(attachment => 
        attachment.size > 5 * 1024 * 1024 || // Larger than 5MB
        !['jpg', 'jpeg', 'png', 'pdf'].includes(attachment.filename.split('.').pop().toLowerCase())
      );
      if (hasSuspiciousAttachment) return true;
    }

    return false; // Not spam
  } catch (err) {
    console.error('Spam detection error:', err.message, err.stack);
    return false; // Default to not spam if detection fails
  }
}

module.exports = { detectSpam };