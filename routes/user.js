const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const User = require('../models/User');

// --- Cấu hình Multer cho việc tải ảnh ---
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    if (filetypes.test(file.mimetype)) return cb(null, true);
    cb(new Error('Chỉ chấp nhận file .jpg, .jpeg, .png'));
  },
  limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn 5MB
});

/**
 * ===================================================================
 * MIDDLEWARE XÁC THỰC TOKEN (NGƯỜI GÁC CỔNG)
 * ===================================================================
 * Mọi API trong file này sẽ phải đi qua hàm này trước tiên.
 * Nó kiểm tra token, nếu hợp lệ thì lấy thông tin user và gắn vào `req.user`.
 * Nếu không hợp lệ, nó sẽ trả về lỗi và dừng lại.
 */
const authenticateToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    req.user = user; // Gắn đối tượng user vào request để các hàm sau sử dụng
    next(); // Cho phép request đi tiếp đến hàm xử lý chính
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

// Áp dụng "người gác cổng" này cho TẤT CẢ các route được định nghĩa bên dưới
router.use(authenticateToken);


/**
 * ===================================================================
 * CÁC ROUTE QUẢN LÝ USER (YÊU CẦU ĐĂNG NHẬP)
 * ===================================================================
 */

// LẤY HỒ SƠ NGƯỜI DÙNG HIỆN TẠI
// Method: GET | URL: /api/user/profile
router.get('/profile', async (req, res) => {
  // Middleware đã xác thực và lấy user, chúng ta chỉ cần trả về thông tin
  const user = req.user;
  res.json({
    phone: user.phone,
    email: user.email,
    name: user.name,
    picture: user.picture,
    twoFactorEnabled: user.twoFactorEnabled,
    isEmailVerified: user.isEmailVerified
  });
});


// CẬP NHẬT HỒ SƠ (EMAIL, TÊN, ẢNH ĐẠI DIỆN)
// Method: POST | URL: /api/user/update-profile
router.post('/update-profile', upload.single('picture'), async (req, res) => {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  
  const { email, name } = req.body;
  const user = req.user; // Lấy user từ middleware

  if (!email) {
      return res.status(400).json({ error: 'Email is required' });
  }
  
  // Kiểm tra xem email mới có bị người khác sử dụng không
  const existingEmailUser = await User.findOne({ email, _id: { $ne: user._id } });
  if (existingEmailUser) {
    return res.status(400).json({ error: 'Email already in use by another account' });
  }

  user.email = email;
  user.name = name || user.name;

  if (req.file) {
    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'email_app_profiles' },
          (error, result) => error ? reject(error) : resolve(result)
        );
        uploadStream.end(req.file.buffer);
      });
      user.picture = result.secure_url;
    } catch (error) {
      return res.status(500).json({ error: 'Failed to upload picture' });
    }
  }

  try {
    const updatedUser = await user.save();
    res.json({ 
        message: 'Profile updated successfully',
        user: { // Trả về thông tin user đã cập nhật
            phone: updatedUser.phone,
            email: updatedUser.email,
            name: updatedUser.name,
            picture: updatedUser.picture,
        }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save profile' });
  }
});


// THAY ĐỔI MẬT KHẨU
// Method: POST | URL: /api/user/change-password
router.post('/change-password', async (req, res) => {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const user = req.user;

    if (!oldPassword || !newPassword || !confirmPassword) {
        return res.status(400).json({ error: 'Please provide all required fields.' });
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ error: 'New passwords do not match.' });
    }

    try {
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Incorrect old password.' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.json({ message: 'Password changed successfully.' });

    } catch (error) {
        res.status(500).json({ error: 'Server error while changing password.' });
    }
});


// BẬT/TẮT 2FA
// Method: POST | URL: /api/user/toggle-2fa
router.post('/toggle-2fa', async (req, res) => {
    const user = req.user;
    if (!user.email || !user.isEmailVerified) {
        return res.status(400).json({ error: 'A verified email is required to enable 2FA.' });
    }

    user.twoFactorEnabled = !user.twoFactorEnabled;
    await user.save();

    res.json({ 
        message: `Two-factor authentication has been ${user.twoFactorEnabled ? 'enabled' : 'disabled'}.`,
        twoFactorEnabled: user.twoFactorEnabled
    });
});

module.exports = router;