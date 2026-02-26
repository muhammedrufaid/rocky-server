const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('../config/db');
const authRoutes = require('./routes/authRoutes');

dotenv.config();
const app = express();

// connect MongoDB
connectDB();

// body parser
app.use(express.json());

// routes
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.send('API is running');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
