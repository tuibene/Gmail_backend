const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const User = require('../models/User');
const Email = require('../models/Email');
const Label = require('../models/Label');
const AutoReply = require('../models/AutoReply');
const { detectSpam } = require('../spamDetection'); // Import spam detection utility

// Cấu hình Multer cho đính kèm
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(file.originalname.toLowerCase().split('.').pop());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only .jpg, .jpeg, .png, .pdf files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Xác thực token
const authenticateToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    console.error('Token verification error:', err.message, err.stack);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Kiểm tra email đã được xác minh
const ensureEmailVerified = async (req, res, next) => {
  if (!req.user.email || !req.user.isEmailVerified) {
    return res.status(400).json({ error: 'Verified email required to perform this action' });
  }
  next();
};

// Gửi email
router.post('/send', authenticateToken, ensureEmailVerified, upload.array('attachments', 5), async (req, res) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  let { recipients, cc, bcc, subject, body } = req.body;

  // Parse JSON strings if provided
  try {
    if (typeof recipients === 'string') recipients = JSON.parse(recipients);
    if (typeof cc === 'string') cc = JSON.parse(cc);
    if (typeof bcc === 'string') bcc = JSON.parse(bcc);
  } catch (err) {
    console.error('JSON parse error:', err.message, err.stack);
    return res.status(400).json({ error: 'Invalid JSON format in recipients, cc, or bcc' });
  }

  // Validate inputs
  if (!Array.isArray(recipients) || recipients.length === 0 || !subject || typeof subject !== 'string' || !body || typeof body !== 'string') {
    return res.status(400).json({ error: 'Recipients (array), subject (string), and body (string) are required' });
  }
  if (cc && !Array.isArray(cc)) {
    return res.status(400).json({ error: 'CC must be an array' });
  }
  if (bcc && !Array.isArray(bcc)) {
    return res.status(400).json({ error: 'BCC must be an array' });
  }

  // Filter out invalid emails
  recipients = recipients.filter(email => typeof email === 'string' && email.trim());
  cc = cc ? cc.filter(email => typeof email === 'string' && email.trim()) : [];
  bcc = bcc ? bcc.filter(email => typeof email === 'string' && email.trim()) : [];

  if (recipients.length === 0) {
    return res.status(400).json({ error: 'At least one valid recipient is required' });
  }

  try {
    // Kiểm tra người nhận, CC, BCC
    const allEmails = [...new Set([...recipients, ...cc, ...bcc])]; // Loại bỏ trùng lặp
    const recipientUsers = await User.find({ email: { $in: allEmails }, isEmailVerified: true });
    const validEmails = new Set(recipientUsers.map(u => u.email));

    if (!recipients.every(email => validEmails.has(email))) {
      return res.status(400).json({ error: 'Some recipients not found or unverified' });
    }
    if (cc.length > 0 && !cc.every(c => validEmails.has(c))) {
      return res.status(400).json({ error: 'Some CC recipients not found or unverified' });
    }
    if (bcc.length > 0 && !bcc.every(b => validEmails.has(b))) {
      return res.status(400).json({ error: 'Some BCC recipients not found or unverified' });
    }

    // Xử lý đính kèm
    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'email_app', resource_type: 'auto' },
            (error, result) => error ? reject(error) : resolve(result)
          );
          uploadStream.end(file.buffer);
        });
        attachments.push({
          url: result.secure_url,
          filename: file.originalname,
          size: file.size
        });
      }
    }

    // Lưu email vào thư mục Sent của người gửi
    const sentEmail = new Email({
      sender: req.user.email,
      recipients,
      cc,
      bcc,
      subject,
      body,
      attachments,
      folder: 'sent',
      sentAt: new Date()
    });
    await sentEmail.save();

    // Lấy io từ app
    const io = req.app.get('io');

    // Kiểm tra spam
    const isSpam = await detectSpam(sentEmail, req.user.email);

    // Lưu email vào Inbox hoặc Spam của người nhận
    for (const recipient of recipients) {
      // Đảm bảo nhãn "Spam" tồn tại cho người nhận
      const recipientUser = recipientUsers.find(u => u.email === recipient);
      let spamLabel = null;
      if (isSpam && recipientUser) {
        spamLabel = await Label.ensureSpamLabel(recipientUser._id);
      }

      const inboxEmail = new Email({
        sender: req.user.email,
        recipients: [recipient],
        cc,
        bcc,
        subject,
        body,
        attachments,
        folder: isSpam ? 'spam' : 'inbox',
        sentAt: sentEmail.sentAt,
        isSpam,
        labels: isSpam && spamLabel ? [spamLabel._id] : []
      });
      await inboxEmail.save();

      // Gửi thông báo qua WebSocket
      if (io) {
        try {
          io.to(recipient).emit('newEmail', {
            sender: req.user.email,
            subject,
            sentAt: inboxEmail.sentAt,
            isSpam
          });
        } catch (wsErr) {
          console.error('WebSocket error for recipient', recipient, wsErr.message, wsErr.stack);
        }
      } else {
        console.warn('Socket.IO not initialized, skipping WebSocket notification for recipient:', recipient);
      }

      // Kiểm tra và gửi Auto Reply (chỉ nếu không phải spam)
      if (!isSpam && recipientUser) {
        const autoReply = await AutoReply.findOne({ userId: recipientUser._id });
        if (autoReply && autoReply.enabled && recipientUser.isEmailVerified) {
          const replyEmail = new Email({
            sender: recipient,
            recipients: [req.user.email],
            subject: `Auto Reply: ${subject}`,
            body: autoReply.message,
            folder: 'sent',
            sentAt: new Date()
          });
          await replyEmail.save();

          const senderInboxEmail = new Email({
            sender: recipient,
            recipients: [req.user.email],
            subject: `Auto Reply: ${subject}`,
            body: autoReply.message,
            folder: 'inbox',
            sentAt: replyEmail.sentAt
          });
          await senderInboxEmail.save();

          if (io) {
            try {
              io.to(req.user.email).emit('newEmail', {
                sender: recipient,
                subject: `Auto Reply: ${subject}`,
                sentAt: senderInboxEmail.sentAt
              });
            } catch (wsErr) {
              console.error('WebSocket error for auto-reply', req.user.email, wsErr.message, wsErr.stack);
            }
          } else {
            console.warn('Socket.IO not initialized, skipping WebSocket notification for auto-reply:', req.user.email);
          }
        }
      }
    }

    // Lưu email vào Inbox hoặc Spam của CC
    for (const ccEmail of cc) {
      const recipientUser = recipientUsers.find(u => u.email === ccEmail);
      let spamLabel = null;
      if (isSpam && recipientUser) {
        spamLabel = await Label.ensureSpamLabel(recipientUser._id);
      }

      const ccInboxEmail = new Email({
        sender: req.user.email,
        recipients: [ccEmail],
        cc,
        bcc,
        subject,
        body,
        attachments,
        folder: isSpam ? 'spam' : 'inbox',
        sentAt: sentEmail.sentAt,
        isSpam,
        labels: isSpam && spamLabel ? [spamLabel._id] : []
      });
      await ccInboxEmail.save();

      if (io) {
        try {
          io.to(ccEmail).emit('newEmail', {
            sender: req.user.email,
            subject,
            sentAt: ccInboxEmail.sentAt,
            isSpam
          });
        } catch (wsErr) {
          console.error('WebSocket error for CC', ccEmail, wsErr.message, wsErr.stack);
        }
      } else {
        console.warn('Socket.IO not initialized, skipping WebSocket notification for CC:', ccEmail);
      }
    }

    // Lưu email vào Inbox hoặc Spam của BCC
    for (const bccEmail of bcc) {
      const recipientUser = recipientUsers.find(u => u.email === bccEmail);
      let spamLabel = null;
      if (isSpam && recipientUser) {
        spamLabel = await Label.ensureSpamLabel(recipientUser._id);
      }

      const bccInboxEmail = new Email({
        sender: req.user.email,
        recipients: [bccEmail],
        cc,
        bcc,
        subject,
        body,
        attachments,
        folder: isSpam ? 'spam' : 'inbox',
        sentAt: sentEmail.sentAt,
        isSpam,
        labels: isSpam && spamLabel ? [spamLabel._id] : []
      });
      await bccInboxEmail.save();

      if (io) {
        try {
          io.to(bccEmail).emit('newEmail', {
            sender: req.user.email,
            subject,
            sentAt: bccInboxEmail.sentAt,
            isSpam
          });
        } catch (wsErr) {
          console.error('WebSocket error for BCC', bccEmail, wsErr.message, wsErr.stack);
        }
      } else {
        console.warn('Socket.IO not initialized, skipping WebSocket notification for BCC:', bccEmail);
      }
    }

    res.json({ message: 'Email sent successfully' });
  } catch (err) {
    console.error('Send email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Lưu bản nháp
router.post('/save-draft', authenticateToken, ensureEmailVerified, upload.array('attachments', 5), async (req, res) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  let { recipients, cc, bcc, subject, body } = req.body;

  try {
    if (recipients && typeof recipients === 'string') {
      recipients = JSON.parse(recipients);
    }
    if (cc && typeof cc === 'string') {
      cc = JSON.parse(cc);
    }
    if (bcc && typeof bcc === 'string') {
      bcc = JSON.parse(bcc);
    }
  } catch (err) {
    console.error('JSON parse error in save-draft:', err.message);
    return res.status(400).json({ error: 'Invalid JSON format in recipients, cc, or bcc' });
  }

  try {
    if (recipients && !Array.isArray(recipients)) {
      return res.status(400).json({ error: 'Recipients must be an array' });
    }
    if (cc && !Array.isArray(cc)) {
      return res.status(400).json({ error: 'CC must be an array' });
    }
    if (bcc && !Array.isArray(bcc)) {
      return res.status(400).json({ error: 'BCC must be an array' });
    }

    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'email_app_attachments' },
            (error, result) => error ? reject(error) : resolve(result)
          );
          uploadStream.end(file.buffer);
        });
        attachments.push({ url: result.secure_url, filename: file.originalname, size: file.size });
      }
    }

    const draftEmail = new Email({
      sender: req.user.email,
      recipients: recipients || [],
      cc: cc || [],
      bcc: bcc || [],
      subject: subject || '',
      body: body || '',
      attachments,
      folder: 'draft',
      draftSavedAt: Date.now()
    });
    await draftEmail.save();
    res.json({ message: 'Draft saved successfully', emailId: draftEmail._id });
  } catch (err) {
    console.error('Save draft error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Trả lời email
router.post('/reply/:emailId', authenticateToken, ensureEmailVerified, upload.array('attachments', 5), async (req, res) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  const { emailId } = req.params;
  const { body } = req.body;

  // Clean the emailId by removing invalid characters
  const cleanEmailId = emailId.replace(/[<|>]/g, '');

  try {
    const originalEmail = await Email.findById(cleanEmailId);
    if (!originalEmail) return res.status(404).json({ error: 'Email not found' });

    const recipientUser = await User.findOne({ email: originalEmail.sender, isEmailVerified: true });
    if (!recipientUser) return res.status(400).json({ error: 'Recipient email not found or unverified' });

    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'email_app_attachments' },
            (error, result) => error ? reject(error) : resolve(result)
          );
          uploadStream.end(file.buffer);
        });
        attachments.push({
          url: result.secure_url,
          filename: file.originalname,
          size: file.size
        });
      }
    }

    const replyEmail = new Email({
      sender: req.user.email,
      recipients: [originalEmail.sender],
      subject: `Re: ${originalEmail.subject}`,
      body: `${body}<br><br>--- Original Message ---<br>${originalEmail.body}`,
      attachments,
      folder: 'sent'
    });

    // Check if reply is spam
    const isSpam = await detectSpam(replyEmail, req.user.email);
    let spamLabel = null;
    if (isSpam) {
      spamLabel = await Label.ensureSpamLabel(recipientUser._id);
    }

    await replyEmail.save();

    const recipientInboxEmail = new Email({
      sender: req.user.email,
      recipients: [originalEmail.sender],
      subject: `Re: ${originalEmail.subject}`,
      body: `${body}<br><br>--- Original Message ---<br>${originalEmail.body}`,
      attachments,
      folder: isSpam ? 'spam' : 'inbox',
      isSpam,
      labels: isSpam && spamLabel ? [spamLabel._id] : []
    });
    await recipientInboxEmail.save();

    // Lấy io từ req.app
    const io = req.app.get('io');
    if (io) {
      io.to(originalEmail.sender).emit('newEmail', {
        sender: req.user.email,
        subject: `Re: ${originalEmail.subject}`,
        sentAt: recipientInboxEmail.sentAt,
        isSpam
      });
    } else {
      console.warn('Socket.IO not initialized, skipping WebSocket notification');
    }

    res.json({ message: 'Reply sent successfully' });
  } catch (err) {
    console.error('Reply email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Chuyển tiếp email
router.post('/forward/:emailId', authenticateToken, ensureEmailVerified, upload.array('attachments', 5), async (req, res) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });

  const { emailId } = req.params;
  let { recipients, body } = req.body;

  // Handle recipients parsing
  try {
    if (typeof recipients === 'string') {
      recipients = JSON.parse(recipients.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Recipients are required and must be an array' });
    }
  } catch (err) {
    console.error('JSON parse error for recipients:', err.message, err.stack);
    return res.status(400).json({ error: 'Invalid JSON format in recipients' });
  }

  try {
    const originalEmail = await Email.findById(emailId);
    if (!originalEmail) return res.status(404).json({ error: 'Email not found' });

    const recipientUsers = await User.find({ email: { $in: recipients }, isEmailVerified: true });
    if (recipientUsers.length !== recipients.length) {
      return res.status(400).json({ error: 'Some recipients not found or unverified' });
    }

    const attachments = originalEmail.attachments || [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'email_app_attachments' },
            (error, result) => error ? reject(error) : resolve(result)
          );
          uploadStream.end(file.buffer);
        });
        attachments.push({
          url: result.secure_url,
          filename: file.originalname,
          size: file.size
        });
      }
    }

    const forwardEmail = new Email({
      sender: req.user.email,
      recipients,
      subject: `Fwd: ${originalEmail.subject}`,
      body: `${body || ''}<br><br>--- Forwarded Message ---<br>${originalEmail.body}`,
      attachments,
      folder: 'sent'
    });

    // Check if forwarded email is spam
    const isSpam = await detectSpam(forwardEmail, req.user.email);

    await forwardEmail.save();

    // Lấy io từ req.app
    const io = req.app.get('io');

    for (const recipient of recipients) {
      const recipientUser = recipientUsers.find(u => u.email === recipient);
      let spamLabel = null;
      if (isSpam && recipientUser) {
        spamLabel = await Label.ensureSpamLabel(recipientUser._id);
      }

      const recipientInboxEmail = new Email({
        sender: req.user.email,
        recipients: [recipient],
        subject: `Fwd: ${originalEmail.subject}`,
        body: `${body || ''}<br><br>--- Forwarded Message ---<br>${originalEmail.body}`,
        attachments,
        folder: isSpam ? 'spam' : 'inbox',
        isSpam,
        labels: isSpam && spamLabel ? [spamLabel._id] : []
      });
      await recipientInboxEmail.save();

      if (io) {
        try {
          io.to(recipient).emit('newEmail', {
            sender: req.user.email,
            subject: `Fwd: ${originalEmail.subject}`,
            sentAt: recipientInboxEmail.sentAt,
            isSpam
          });
        } catch (wsErr) {
          console.error('WebSocket error for recipient', recipient, wsErr.message, wsErr.stack);
        }
      } else {
        console.warn('Socket.IO not initialized, skipping WebSocket notification for recipient:', recipient);
      }
    }

    res.json({ message: 'Email forwarded successfully' });
  } catch (err) {
    console.error('Forward email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Lấy danh sách email
router.get('/list/:folder', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { folder } = req.params;
  const { labelId, page = 1, limit = 20 } = req.query;
  const userEmail = req.user.email;

  try {
    const validFolders = ['inbox', 'sent', 'draft', 'starred', 'trash', 'spam']; // Added 'spam'
    if (!validFolders.includes(folder)) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    let query = {};
    switch (folder) {
      case 'inbox':
        query = {
          $or: [{ recipients: userEmail }, { cc: userEmail }, { bcc: userEmail }],
          folder: 'inbox'
        };
        break;
      case 'sent':
        query = { sender: userEmail, folder: 'sent' };
        break;
      case 'draft':
        query = { sender: userEmail, folder: 'draft' };
        break;
      case 'trash':
        query = {
          $or: [{ sender: userEmail }, { recipients: userEmail }, { cc: userEmail }, { bcc: userEmail }],
          folder: 'trash'
        };
        break;
      case 'starred':
        query = {
          $or: [{ sender: userEmail }, { recipients: userEmail }, { cc: userEmail }, { bcc: userEmail }],
          isStarred: true
        };
        break;
      case 'spam':
        query = {
          $or: [{ recipients: userEmail }, { cc: userEmail }, { bcc: userEmail }],
          folder: 'spam'
        };
        break;
    }

    if (labelId) {
      if (!mongoose.isValidObjectId(labelId)) {
        return res.status(400).json({ error: 'Invalid label ID' });
      }
      query.labels = labelId;
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const selectFields = 'sender recipients cc bcc subject sentAt draftSavedAt isRead isStarred isSpam labels';

    const emails = await Email.find(query)
      .select(selectFields)
      .sort({ sentAt: -1, draftSavedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate('labels', 'name');

    res.json(emails);
  } catch (err) {
    console.error('List emails error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Đánh dấu email là đã đọc/chưa đọc
router.patch('/mark-read/:emailId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;
  const { isRead } = req.body;

  try {
    if (!mongoose.isValidObjectId(emailId)) {
      return res.status(400).json({ error: 'Invalid email ID' });
    }
    if (typeof isRead !== 'boolean') {
      return res.status(400).json({ error: 'isRead must be a boolean' });
    }

    const updated = await Email.updateOne(
      {
        _id: emailId,
        $or: [
          { sender: req.user.email },
          { recipients: req.user.email },
          { cc: req.user.email },
          { bcc: req.user.email }
        ]
      },
      { isRead }
    );
    if (updated.matchedCount === 0) {
      return res.status(404).json({ error: 'Email not found or unauthorized' });
    }

    res.json({ message: 'Email read status updated' });
  } catch (err) {
    console.error('Mark read error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Đánh dấu sao cho email
router.patch('/star/:emailId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;
  const { isStarred } = req.body;

  try {
    if (!mongoose.isValidObjectId(emailId)) {
      return res.status(400).json({ error: 'Invalid email ID format' });
    }
    if (typeof isStarred !== 'boolean') {
      return res.status(400).json({ error: 'isStarred must be a boolean value' });
    }

    const email = await Email.findOneAndUpdate(
      {
        _id: emailId,
        $or: [
          { sender: req.user.email },
          { recipients: req.user.email },
          { cc: req.user.email },
          { bcc: req.user.email }
        ]
      },
      { isStarred },
      { new: true, select: 'sender recipients subject sentAt isRead isStarred isSpam labels' }
    ).populate('labels');

    if (!email) {
      return res.status(404).json({ 
        error: 'Email not found or you are not authorized to modify it' 
      });
    }

    res.json(email);
  } catch (err) {
    console.error(`Star email error for emailId ${emailId}:`, err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Chuyển email vào thùng rác
router.patch('/move-to-trash/:emailId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;

  try {
    if (!mongoose.isValidObjectId(emailId)) {
      return res.status(400).json({ error: 'Invalid email ID' });
    }

    const updated = await Email.updateOne(
      {
        _id: emailId,
        $or: [
          { sender: req.user.email },
          { recipients: req.user.email },
          { cc: req.user.email },
          { bcc: req.user.email }
        ]
      },
      { folder: 'trash' }
    );
    if (updated.matchedCount === 0) {
      return res.status(404).json({ error: 'Email not found or unauthorized' });
    }

    res.json({ message: 'Email moved to trash' });
  } catch (err) {
    console.error('Move to trash error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Tìm kiếm email
router.get('/search', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { keyword, from, to, hasAttachment, startDate, endDate } = req.query;
  const userEmail = req.user.email;

  try {
    const matchConditions = {
      $and: [
        {
          $or: [
            { sender: userEmail },
            { recipients: userEmail },
            { cc: userEmail },
            { bcc: userEmail }
          ]
        }
      ],
      folder: { $ne: 'trash' }
    };

    if (keyword) {
      matchConditions.$and.push({
        $or: [
          { subject: { $regex: keyword, $options: 'i' } },
          { body: { $regex: keyword, $options: 'i' } }
        ]
      });
    }

    if (from) {
      matchConditions.sender = { $regex: from, $options: 'i' };
    }
    if (to) {
      matchConditions.$or = [
        { recipients: { $regex: to, $options: 'i' } },
        { cc: { $regex: to, $options: 'i' } }
      ];
    }
    if (hasAttachment === 'true') {
      matchConditions.attachments = { $exists: true, $ne: [] };
    }
    if (startDate || endDate) {
      matchConditions.sentAt = {};
      if (startDate) matchConditions.sentAt.$gte = new Date(startDate);
      if (endDate) matchConditions.sentAt.$lte = new Date(endDate);
    }

    const emails = await Email.aggregate([
      { $match: matchConditions },
      {
        $sort: {
          sentAt: -1,
          folder: 1
        }
      },
      {
        $group: {
          _id: {
            sender: "$sender",
            subject: "$subject",
            sentAt: "$sentAt"
          },
          originalDoc: { $first: "$$ROOT" }
        }
      },
      {
        $replaceRoot: { newRoot: "$originalDoc" }
      },
      {
        $sort: { sentAt: -1 }
      }
    ]);

    res.json(emails);
  } catch (err) {
    console.error('Search email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Quản lý nhãn
router.post('/labels', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Label name is required' });

  try {
    const existingLabel = await Label.findOne({ userId: req.user._id, name });
    if (existingLabel) return res.status(400).json({ error: 'Label name already exists' });

    const label = new Label({ userId: req.user._id, name });
    await label.save();
    res.json({ message: 'Label created successfully', label });
  } catch (err) {
    console.error('Create label error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/labels/:labelId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { labelId } = req.params;

  try {
    if (!mongoose.isValidObjectId(labelId)) {
      return res.status(400).json({ error: 'Invalid label ID' });
    }

    const label = await Label.findOne({ _id: labelId, userId: req.user._id });
    if (!label) return res.status(404).json({ error: 'Label not found or unauthorized' });
    if (label.isSystemLabel) return res.status(400).json({ error: 'Cannot delete system label' });

    const deleted = await Label.deleteOne({ _id: labelId, userId: req.user._id });
    if (deleted.deletedCount === 0) {
      return res.status(404).json({ error: 'Label not found or unauthorized' });
    }

    await Email.updateMany({ labels: labelId }, { $pull: { labels: labelId } });
    res.json({ message: 'Label deleted successfully' });
  } catch (err) {
    console.error('Delete label error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/labels/:labelId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { labelId } = req.params;
  const { name } = req.body;

  try {
    if (!mongoose.isValidObjectId(labelId)) {
      return res.status(400).json({ error: 'Invalid label ID' });
    }
    if (!name) return res.status(400).json({ error: 'Label name is required' });

    const label = await Label.findOne({ _id: labelId, userId: req.user._id });
    if (!label) return res.status(404).json({ error: 'Label not found or unauthorized' });
    if (label.isSystemLabel) return res.status(400).json({ error: 'Cannot modify system label' });

    const updated = await Label.updateOne(
      { _id: labelId, userId: req.user._id },
      { name }
    );
    if (updated.matchedCount === 0) {
      return res.status(404).json({ error: 'Label not found or unauthorized' });
    }

    res.json({ message: 'Label updated successfully' });
  } catch (err) {
    console.error('Update label error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Gán/xóa nhãn cho email
router.patch('/emails/:emailId/labels', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;
  const { labelId, action } = req.body;

  try {
    if (!mongoose.isValidObjectId(emailId) || !mongoose.isValidObjectId(labelId)) {
      return res.status(400).json({ error: 'Invalid email or label ID' });
    }
    if (!['add', 'remove'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const email = await Email.findOne({
      _id: emailId,
      $or: [
        { sender: req.user.email },
        { recipients: req.user.email },
        { cc: req.user.email },
        { bcc: req.user.email }
      ]
    });
    if (!email) return res.status(404).json({ error: 'Email not found or unauthorized' });

    const label = await Label.findOne({ _id: labelId, userId: req.user._id });
    if (!label) return res.status(404).json({ error: 'Label not found or unauthorized' });

    if (action === 'add') {
      if (!email.labels.includes(labelId)) email.labels.push(labelId);
    } else if (action === 'remove') {
      email.labels = email.labels.filter(id => id.toString() !== labelId);
    }
    await email.save();
    res.json({ message: 'Label updated successfully' });
  } catch (err) {
    console.error('Update email labels error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Lấy danh sách nhãn
router.get('/labels', authenticateToken, ensureEmailVerified, async (req, res) => {
  try {
    const labels = await Label.find({ userId: req.user._id });
    res.json(labels);
  } catch (err) {
    console.error('Get labels error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cấu hình Auto Reply
router.post('/auto-reply', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { enabled, message } = req.body;

  try {
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }
    if (message && typeof message !== 'string') {
      return res.status(400).json({ error: 'Message must be a string' });
    }

    let autoReply = await AutoReply.findOne({ userId: req.user._id });
    if (!autoReply) {
      autoReply = new AutoReply({ userId: req.user._id, enabled, message });
    } else {
      autoReply.enabled = enabled;
      autoReply.message = message || autoReply.message;
      autoReply.updatedAt = Date.now();
    }
    await autoReply.save();
    res.json({ message: 'Auto reply settings updated', autoReply });
  } catch (err) {
    console.error('Auto reply error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Lấy thông tin email
router.get('/emails/:emailId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;

  try {
    if (!mongoose.isValidObjectId(emailId)) {
      return res.status(400).json({ error: 'Invalid email ID' });
    }

    const email = await Email.findOne({
      _id: emailId,
      $or: [
        { sender: req.user.email },
        { recipients: req.user.email },
        { cc: req.user.email },
        { bcc: req.user.email }
      ]
    }).populate('labels');

    if (!email) {
      return res.status(404).json({ error: 'Email not found or unauthorized' });
    }

    res.json(email);
  } catch (err) {
    console.error('Get email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:emailId', authenticateToken, ensureEmailVerified, async (req, res) => {
  const { emailId } = req.params;
  const userEmail = req.user.email;

  try {
    if (!mongoose.isValidObjectId(emailId)) {
      return res.status(400).json({ error: 'Invalid email ID' });
    }

    const result = await Email.deleteOne({
      _id: emailId,
      $or: [
        { sender: userEmail },
        { recipients: userEmail },
        { cc: userEmail },
        { bcc: userEmail }
      ]
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Email not found or you are not authorized to delete it' });
    }

    res.json({ message: 'Email permanently deleted' });
  } catch (err) {
    console.error('Delete email error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;