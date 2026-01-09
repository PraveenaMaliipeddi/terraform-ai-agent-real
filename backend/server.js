// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const AWS = require('aws-sdk');
const terraformRouter = require('./routes/terraform');

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  message: { error: 'Too many requests, please try again later.' }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(limiter);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Terraform AI Agent API',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================================
// SECURE AWS AUTHENTICATION ROUTES
// ============================================================================

/**
 * AWS SSO Authentication
 * Redirects user to AWS SSO login page
 */
app.get('/api/auth/aws-sso', (req, res) => {
  const { redirect_uri } = req.query;

  // TODO: Replace with your actual AWS SSO configuration
  const AWS_SSO_START_URL = process.env.AWS_SSO_START_URL || 'https://your-sso-portal.awsapps.com/start';
  const AWS_SSO_REGION = process.env.AWS_SSO_REGION || 'us-east-1';
  
  // Build SSO authorization URL
  const ssoUrl = new URL(AWS_SSO_START_URL);
  ssoUrl.searchParams.append('client_id', process.env.AWS_SSO_CLIENT_ID || 'your-client-id');
  ssoUrl.searchParams.append('redirect_uri', redirect_uri || `${process.env.FRONTEND_URL}/callback`);
  ssoUrl.searchParams.append('response_type', 'code');
  ssoUrl.searchParams.append('scope', 'openid profile');

  console.log('🔐 Redirecting to AWS SSO:', ssoUrl.toString());
  res.redirect(ssoUrl.toString());
});

/**
 * AWS CLI Profile Authentication
 * Uses locally configured AWS credentials from ~/.aws/credentials
 * This works if your server has AWS CLI configured
 */
app.post('/api/auth/cli-profile', async (req, res) => {
  try {
    const { profile } = req.body;

    // Use default AWS credentials chain (environment vars, ~/.aws/credentials, instance profile)
    const credentials = profile 
      ? new AWS.SharedIniFileCredentials({ profile })
      : new AWS.CredentialProviderChain().resolve();

    AWS.config.credentials = credentials;

    // Verify credentials by calling STS
    const sts = new AWS.STS();
    const identity = await sts.getCallerIdentity().promise();

    console.log('✅ AWS CLI Profile authenticated:', identity.Account);

    // Store session (use redis/sessions in production)
    const sessionId = generateSessionId();
    
    res.json({
      success: true,
      accountId: identity.Account,
      userId: identity.UserId,
      arn: identity.Arn,
      sessionId: sessionId,
      message: 'Successfully authenticated with AWS CLI profile'
    });

  } catch (error) {
    console.error('❌ AWS CLI Profile authentication failed:', error.message);
    
    res.status(401).json({
      success: false,
      error: 'AWS CLI authentication failed',
      message: error.code === 'CredentialsError' 
        ? 'No AWS credentials found. Please configure AWS CLI first: aws configure'
        : error.message,
      hint: 'Run "aws configure" in your terminal to set up credentials'
    });
  }
});

/**
 * AWS Cognito OAuth Authentication
 * Redirects to AWS Cognito hosted UI
 */
app.get('/api/auth/cognito', (req, res) => {
  const { redirect_uri } = req.query;

  // TODO: Replace with your Cognito configuration
  const COGNITO_DOMAIN = process.env.AWS_COGNITO_DOMAIN; // e.g., 'your-app.auth.us-east-1.amazoncognito.com'
  const COGNITO_CLIENT_ID = process.env.AWS_COGNITO_CLIENT_ID;
  const COGNITO_REGION = process.env.AWS_COGNITO_REGION || 'us-east-1';

  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    return res.status(500).json({
      error: 'Cognito not configured',
      message: 'Please set AWS_COGNITO_DOMAIN and AWS_COGNITO_CLIENT_ID in .env file'
    });
  }

  // Build Cognito OAuth URL
  const cognitoUrl = new URL(`https://${COGNITO_DOMAIN}/oauth2/authorize`);
  cognitoUrl.searchParams.append('client_id', COGNITO_CLIENT_ID);
  cognitoUrl.searchParams.append('response_type', 'code');
  cognitoUrl.searchParams.append('scope', 'openid profile aws.cognito.signin.user.admin');
  cognitoUrl.searchParams.append('redirect_uri', redirect_uri || `${process.env.FRONTEND_URL}/callback`);

  console.log('🔐 Redirecting to AWS Cognito:', cognitoUrl.toString());
  res.redirect(cognitoUrl.toString());
});

/**
 * OAuth Callback Handler
 * Handles the redirect back from AWS SSO or Cognito
 */
app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('❌ OAuth error:', error);
    return res.redirect(`${process.env.FRONTEND_URL}?auth_error=${error}`);
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  try {
    // TODO: Exchange authorization code for access token
    // This depends on whether you're using SSO or Cognito
    
    // For SSO, you'd call AWS SSO OIDC token endpoint
    // For Cognito, you'd call Cognito token endpoint

    console.log('✅ Received authorization code, exchanging for tokens...');

    // Store session and redirect back to frontend
    const sessionId = generateSessionId();
    
    res.redirect(`${process.env.FRONTEND_URL}?session_id=${sessionId}&auth_success=true`);

  } catch (error) {
    console.error('❌ Token exchange failed:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}?auth_error=token_exchange_failed`);
  }
});

/**
 * Verify AWS Credentials (Legacy - for debugging only)
 * NOTE: This endpoint should NOT accept raw access keys in production
 */
app.post('/api/verify-credentials', async (req, res) => {
  // This is just for local development/testing
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      error: 'Endpoint disabled in production',
      message: 'Please use AWS SSO, CLI profiles, or Cognito authentication'
    });
  }

  const { accessKeyId, secretAccessKey, region } = req.body;

  if (!accessKeyId || !secretAccessKey) {
    return res.status(400).json({
      success: false,
      error: 'Missing credentials'
    });
  }

  try {
    const sts = new AWS.STS({
      accessKeyId,
      secretAccessKey,
      region: region || 'us-east-1'
    });

    const identity = await sts.getCallerIdentity().promise();

    res.json({
      success: true,
      account: identity.Account,
      userId: identity.UserId,
      arn: identity.Arn
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid AWS credentials',
      message: error.message
    });
  }
});

/**
 * Session Info Endpoint
 * Returns info about current session
 */
app.get('/api/auth/session', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(401).json({ authenticated: false });
  }

  // TODO: Validate session from your session store (Redis, DB, etc.)
  
  res.json({
    authenticated: true,
    sessionId: sessionId,
    expiresAt: new Date(Date.now() + 3600000).toISOString() // 1 hour
  });
});

/**
 * Logout Endpoint
 * Clears session
 */
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  // TODO: Clear session from your session store
  
  console.log('👋 User logged out');
  res.json({ success: true, message: 'Logged out successfully' });
});

// ============================================================================
// EXISTING ROUTES
// ============================================================================

app.use('/api', terraformRouter);

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a random session ID
 */
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Terraform AI Backend running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 Auth Methods: AWS SSO, CLI Profile, Cognito`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
});

module.exports = app;