require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('../config/db');
const authRoutes = require('./routes/authRoutes');
const frontendRoutes = require('./routes/frontendRoutes');
const salesforceRoutes = require('./routes/salesforceRoutes');
const contactRoutes = require('./routes/contactRoutes');
const sellRoutes = require('./routes/sellRoutes');
const { startSalesforceMigrateScheduler } = require('./jobs/salesforceMigrateScheduler');

const app = express();
// Port 5000 is often used by AirPlay on macOS - use 5001 as fallback
const PORT = process.env.PORT || 5001;

// Middleware - CORS must allow your frontend origin
app.use(
  cors({
    origin: true, // Allow request origin (or use '*' for all)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);
// Allow posting raw XML (content-type: application/xml or text/xml)
app.use(
  express.text({
    type: ['application/xml', 'text/xml', 'application/xhtml+xml', 'text/plain'],
    limit: '50mb',
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/frontend', frontendRoutes);
app.use('/api/salesforce', salesforceRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/sell', sellRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Rocky RealEstate API is running' });
});

const bootstrap = async () => {
  await connectDB();
  startSalesforceMigrateScheduler();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
