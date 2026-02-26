require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('../config/db');
const authRoutes = require('./routes/authRoutes');
const frontendRoutes = require('./routes/frontendRoutes');

const app = express();
// Port 5000 is often used by AirPlay on macOS - use 5001 as fallback
const PORT = process.env.PORT || 5001;

// Connect to MongoDB
connectDB(); ''

// Middleware - CORS must allow your frontend origin
app.use(
  cors({
    origin: true, // Allow request origin (or use '*' for all)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/frontend', frontendRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Rocky RealEstate API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
