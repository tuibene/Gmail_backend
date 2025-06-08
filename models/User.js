const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, unique: true, sparse: true }, // Email không bắt buộc khi đăng ký
  name: { type: String },
  picture: { type: String },
  twoFactorEnabled: { type: Boolean, default: false },
  isEmailVerified: { type: Boolean, default: false }, // Thêm trường để theo dõi trạng thái xác minh email
  otp: { type: String },
  otpExpires: { type: Date }
});

// Middleware để kiểm tra email trước khi lưu
userSchema.pre('save', async function (next) {
  if (this.isModified('email') && this.email) {
    // Kiểm tra định dạng email
    const emailRegex = /^[\w-\.]+@([\w-]+\.)+[\w-]{2,}$/;
    if (!emailRegex.test(this.email)) {
      return next(new Error('Invalid email format'));
    }
    // Đánh dấu email là đã xác minh nếu được cập nhật (tùy chọn: có thể thêm bước xác minh OTP)
    this.isEmailVerified = true;
  }
  next();
});

module.exports = mongoose.model('User', userSchema);