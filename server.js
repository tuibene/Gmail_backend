const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const emailRoutes = require('./routes/email');
const userRoutes = require('./routes/user');

// Explicitly specify the path to .env
dotenv.config({ path: __dirname + '/.env' });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Kết nối MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB connection error:', err));

// WebSocket: Lưu kết nối người dùng
io.on('connection', (socket) => {
  socket.on('join', (email) => {
    if (typeof email === 'string' && email.trim()) {
      socket.join(email);
      console.log(`${email} joined WebSocket`);
    } else {
      console.error('Invalid email for join:', email);
    }
  });
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Gán io vào app để sử dụng trong routes
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/user', userRoutes);

// Khởi động server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));