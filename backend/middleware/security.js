// backend/middleware/security.js

/**
 * Security middleware for the Terraform AI backend
 * Provides basic security headers and validation
 */

const helmet = require('helmet');

/**
 * Apply security headers using helmet
 */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });
}

/**
 * Validate AWS credentials format
 */
function validateAwsCredentials(req, res, next) {
  const { roleArn, externalId } = req.body;

  if (roleArn) {
    // Validate Role ARN format
    const arnPattern = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
    if (!arnPattern.test(roleArn)) {
      return res.status(400).json({
        error: 'Invalid Role ARN format',
        message: 'Role ARN must match pattern: arn:aws:iam::123456789012:role/RoleName'
      });
    }
  }

  if (externalId) {
    // Validate External ID (should be 64 hex characters)
    if (!/^[a-f0-9]{64}$/.test(externalId)) {
      return res.status(400).json({
        error: 'Invalid External ID format',
        message: 'External ID must be 64 hexadecimal characters'
      });
    }
  }

  next();
}

/**
 * Sanitize user input to prevent injection attacks
 */
function sanitizeInput(req, res, next) {
  const { message } = req.body;

  if (message) {
    // Remove potentially dangerous characters
    const sanitized = message
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();

    req.body.message = sanitized;
  }

  next();
}

/**
 * Request logging middleware
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });

  next();
}

/**
 * Check for required environment variables
 */
function checkEnvironment(req, res, next) {
  const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Backend AWS credentials not configured. Please contact administrator.',
      missing: process.env.NODE_ENV === 'development' ? missing : undefined
    });
  }

  next();
}

module.exports = {
  securityHeaders,
  validateAwsCredentials,
  sanitizeInput,
  requestLogger,
  checkEnvironment
};