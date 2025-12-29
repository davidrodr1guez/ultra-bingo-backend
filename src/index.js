import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';

// x402 v1 middleware para UltravioletaDAO (compatible con uvd-x402-sdk)
import { createX402Middleware } from './middleware/x402v2.js';

import { config } from './config/index.js';
import { connectDB } from './db/connection.js';
import { ensureAvailableCards } from './services/gameState.js';
import { setupSocketHandlers } from './services/socket.js';

// SECURITY: Import security middleware
import { rateLimit, sanitizeRequest, securityHeaders, auditLog } from './middleware/security.js';

// Routes
import authRoutes from './routes/auth.js';
import cardsRoutes from './routes/cards.js';
import gameRoutes from './routes/game.js';
import adminRoutes from './routes/admin.js';

const app = express();
const httpServer = createServer(app);

// Allowed origins for CORS (supports multiple domains)
const allowedOrigins = [
  config.frontendUrl,
  'https://bingo.ultravioletadao.xyz',
  'https://ultra-bingo-frontend.vercel.app',
  'http://localhost:5173',
].filter(Boolean);

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Make io accessible to routes
app.set('io', io);

// CORS middleware with x402 headers
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  exposedHeaders: [
    'PAYMENT-REQUIRED',
    'Payment-Required',
    'payment-required',
    'PAYMENT-RESPONSE',
    'Payment-Response',
  ],
}));

// Handle preflight for x402 headers
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Headers',
      'Content-Type, Authorization, PAYMENT-SIGNATURE, Payment-Signature, payment-signature, X-PAYMENT, x-payment');
    res.header('Access-Control-Expose-Headers',
      'PAYMENT-REQUIRED, Payment-Required, PAYMENT-RESPONSE, Payment-Response');
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '1mb' })); // SECURITY: Limit body size

// SECURITY: Apply security middlewares
app.use(securityHeaders);
app.use(sanitizeRequest);

// SECURITY: Apply general rate limiting
app.use(rateLimit('general'));

// SECURITY: Helmet for additional security headers
app.use(helmet({
  contentSecurityPolicy: false, // Handled by our custom middleware
  crossOriginEmbedderPolicy: false,
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SECURITY: Log all requests to sensitive endpoints
app.use('/api/admin', (req, res, next) => {
  auditLog({
    action: 'ADMIN_API_REQUEST',
    method: req.method,
    path: req.path,
    ip: req.ip,
    userId: req.user?.userId,
  });
  next();
});

// x402 route configs
const x402RouteConfigs = {
  'POST /api/cards/purchase': {
    price: config.cardPrice,
    description: 'Purchase bingo cards',
  },
};

console.log('[x402] Configuring payment middleware:', {
  receiverAddress: config.x402.receiverAddress,
  facilitatorUrl: config.x402.facilitatorUrl,
  network: config.x402.network,
  routes: Object.keys(x402RouteConfigs),
});

// Apply x402 payment middleware
app.use(createX402Middleware(x402RouteConfigs));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/admin', adminRoutes);

// SECURITY: Sanitized error handling - never expose internal details
app.use((err, req, res, next) => {
  // Log full error internally for debugging
  console.error('Error:', err.message);

  // SECURITY: Never expose internal error details to client
  const statusCode = err.status || 500;
  const isProduction = config.nodeEnv === 'production';

  // Safe error messages for client
  const safeMessages = {
    400: 'Bad request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not found',
    429: 'Too many requests',
    500: 'Internal server error',
  };

  // In development, show actual message; in production, use safe message
  const clientMessage = isProduction
    ? safeMessages[statusCode] || 'An error occurred'
    : err.message || safeMessages[statusCode] || 'An error occurred';

  res.status(statusCode).json({
    error: clientMessage,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Setup socket handlers
setupSocketHandlers(io);

// Start server with MongoDB connection
async function startServer() {
  try {
    // Connect to MongoDB
    await connectDB();

    // Ensure we have available cards
    await ensureAvailableCards(20, 50);

    // Start HTTP server
    httpServer.listen(config.port, () => {
      console.log(`
╔════════════════════════════════════════════════════╗
║           Ultra Bingo Backend Server               ║
╠════════════════════════════════════════════════════╣
║  Port: ${config.port}                                       ║
║  Environment: ${config.nodeEnv.padEnd(35)}║
║  Frontend URL: ${config.frontendUrl.padEnd(34)}║
║  x402 Network: ${config.x402.network.padEnd(34)}║
║  x402 Receiver: ${config.x402.receiverAddress.substring(0, 10)}...${config.x402.receiverAddress.substring(38).padEnd(21)}║
║  x402 Version: v1 (UltravioletaDAO SDK)           ║
║  Database: MongoDB Atlas                          ║
╚════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export { app, io };
