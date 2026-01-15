// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const terraformRouter = require('./routes/terraform');

const app = express();
const PORT = process.env.PORT || 3001;

// CRITICAL: Trust first proxy (required for Render)
app.set('trust proxy', 1);

// CORS configuration
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://terraform-ai-agent-real.vercel.app'
  ],
  credentials: true
}));

// Body parser
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Health check routes
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Terraform AI Agent API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString() 
  });
});

// API routes
app.use('/api', terraformRouter);

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Terraform AI Backend running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 Auth Methods: AWS SSO, CLI Profile, Cognito`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
});

module.exports = app;