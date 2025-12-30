import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/**
 * SECURITY: In-memory rate limiter with sliding window
 * For production, use Redis for distributed rate limiting
 */
const rateLimitStore = new Map();

// Audit log storage (in production, use a proper database/logging service)
const auditLogs = [];

/**
 * Rate limiter configuration
 */
const RATE_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, maxRequests: 10 }, // 10 requests per 15 minutes
  register: { windowMs: 5 * 60 * 1000, maxRequests: 10 }, // 10 per 5 minutes (more lenient)
  purchase: { windowMs: 60 * 1000, maxRequests: 20 }, // 20 per minute
  adminAction: { windowMs: 60 * 1000, maxRequests: 60 }, // 60 per minute
  general: { windowMs: 60 * 1000, maxRequests: 200 }, // 200 per minute
};

/**
 * Clean expired entries from rate limit store
 */
function cleanExpiredEntries() {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > data.windowMs) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean every 5 minutes
setInterval(cleanExpiredEntries, 5 * 60 * 1000);

/**
 * SECURITY: Rate limiting middleware factory
 * @param {string} type - Type of rate limit to apply
 */
export function rateLimit(type = 'general') {
  const limits = RATE_LIMITS[type] || RATE_LIMITS.general;

  return (req, res, next) => {
    // Get client identifier (IP + user agent hash for better tracking)
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    const clientId = crypto
      .createHash('sha256')
      .update(`${clientIp}:${userAgent}:${type}`)
      .digest('hex')
      .substring(0, 16);

    const now = Date.now();
    const key = `rate:${type}:${clientId}`;

    let data = rateLimitStore.get(key);

    if (!data || now - data.windowStart > limits.windowMs) {
      // New window
      data = {
        windowStart: now,
        windowMs: limits.windowMs,
        requests: 1,
      };
      rateLimitStore.set(key, data);
    } else {
      data.requests++;
    }

    // Set rate limit headers
    res.set('X-RateLimit-Limit', limits.maxRequests);
    res.set('X-RateLimit-Remaining', Math.max(0, limits.maxRequests - data.requests));
    res.set('X-RateLimit-Reset', new Date(data.windowStart + limits.windowMs).toISOString());

    if (data.requests > limits.maxRequests) {
      // Log rate limit violation
      auditLog({
        action: 'RATE_LIMIT_EXCEEDED',
        clientIp,
        type,
        requests: data.requests,
        maxAllowed: limits.maxRequests,
      });

      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((data.windowStart + limits.windowMs - now) / 1000),
      });
    }

    next();
  };
}

/**
 * SECURITY: Enhanced admin verification middleware
 * Verifies both JWT token AND wallet whitelist
 */
export function verifyAdminStrict(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    auditLog({
      action: 'ADMIN_ACCESS_DENIED',
      reason: 'No token provided',
      ip: req.ip,
    });
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // SECURITY: Must have isAdmin flag
    if (decoded.isAdmin !== true) {
      auditLog({
        action: 'ADMIN_ACCESS_DENIED',
        reason: 'Token not admin',
        userId: decoded.userId,
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Admin access required' });
    }

    // SECURITY: Wallet MUST be in whitelist
    const wallet = decoded.wallet?.toLowerCase();
    if (!wallet || !config.adminWallets.includes(wallet)) {
      auditLog({
        action: 'ADMIN_ACCESS_DENIED',
        reason: 'Wallet not whitelisted',
        wallet,
        userId: decoded.userId,
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Admin wallet not authorized' });
    }

    // Log successful admin access
    auditLog({
      action: 'ADMIN_ACCESS_GRANTED',
      userId: decoded.userId,
      wallet,
      ip: req.ip,
      path: req.path,
    });

    req.user = decoded;
    next();
  } catch (err) {
    auditLog({
      action: 'ADMIN_ACCESS_DENIED',
      reason: 'Invalid token',
      error: err.message,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * SECURITY: Audit logging function
 * @param {Object} logEntry - Log entry object
 */
export function auditLog(logEntry) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...logEntry,
  };

  // Store in memory (limit to last 10000 entries)
  auditLogs.push(entry);
  if (auditLogs.length > 10000) {
    auditLogs.shift();
  }

  // Console log for important events
  const criticalActions = [
    'ADMIN_ACCESS_DENIED',
    'RATE_LIMIT_EXCEEDED',
    'CARD_INTEGRITY_FAILED',
    'WINNER_VERIFICATION_FAILED',
    'SUSPICIOUS_ACTIVITY',
  ];

  if (criticalActions.includes(logEntry.action)) {
    console.warn('[SECURITY AUDIT]', JSON.stringify(entry));
  } else {
    console.log('[AUDIT]', JSON.stringify(entry));
  }
}

/**
 * Get audit logs (for admin dashboard)
 * @param {number} limit - Max number of logs to return
 * @returns {Array} Audit log entries
 */
export function getAuditLogs(limit = 100) {
  return auditLogs.slice(-limit);
}

/**
 * SECURITY: Request sanitization middleware
 * Removes potentially dangerous characters from inputs
 */
export function sanitizeRequest(req, res, next) {
  // Sanitize body
  if (req.body && typeof req.body === 'object') {
    sanitizeObject(req.body);
  }

  // Sanitize query params
  if (req.query && typeof req.query === 'object') {
    sanitizeObject(req.query);
  }

  next();
}

/**
 * Recursively sanitize object values
 */
function sanitizeObject(obj) {
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      // Remove null bytes and control characters
      obj[key] = obj[key].replace(/\x00/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

      // Prevent NoSQL injection patterns
      if (obj[key].includes('$') && (obj[key].includes('{') || obj[key].startsWith('$'))) {
        obj[key] = obj[key].replace(/\$/g, '');
      }
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizeObject(obj[key]);
    }
  }
}

/**
 * SECURITY: Validate Fibonacci quantity
 * Ensures card purchase quantities are valid Fibonacci numbers
 */
export function validateFibonacciQuantity(req, res, next) {
  const quantity = parseInt(req.body?.quantity) || parseInt(req.query?.quantity);
  const validQuantities = [1, 2, 3, 5, 8, 13, 21, 34];

  if (!quantity || !validQuantities.includes(quantity)) {
    auditLog({
      action: 'INVALID_QUANTITY_ATTEMPT',
      quantity,
      validQuantities,
      ip: req.ip,
      userId: req.user?.userId,
    });
    return res.status(400).json({
      error: 'Invalid quantity. Must be a Fibonacci number: 1, 2, 3, 5, 8, 13, 21, or 34',
    });
  }

  next();
}

/**
 * SECURITY: Security headers middleware
 */
export function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  res.set('X-Content-Type-Options', 'nosniff');

  // XSS protection
  res.set('X-XSS-Protection', '1; mode=block');

  // Strict transport security (for HTTPS)
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Content Security Policy
  res.set('Content-Security-Policy', "default-src 'self'");

  // Referrer policy
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  next();
}

export default {
  rateLimit,
  verifyAdminStrict,
  auditLog,
  getAuditLogs,
  sanitizeRequest,
  validateFibonacciQuantity,
  securityHeaders,
};
