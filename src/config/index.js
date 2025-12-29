import dotenv from 'dotenv';
dotenv.config();

// SECURITY: Validate required environment variables
const requiredEnvVars = ['JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_WALLETS', 'X402_RECEIVER_ADDRESS'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0 && process.env.NODE_ENV === 'production') {
  console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// SECURITY: Validate X402_RECEIVER_ADDRESS format
if (process.env.X402_RECEIVER_ADDRESS && !/^0x[a-fA-F0-9]{40}$/.test(process.env.X402_RECEIVER_ADDRESS)) {
  console.error('FATAL: X402_RECEIVER_ADDRESS must be a valid Ethereum address');
  process.exit(1);
}

export const config = {
  // Server
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  // JWT - NO DEFAULT VALUE FOR SECURITY
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: '7d',

  // Admin - NO DEFAULT VALUE FOR SECURITY
  adminPassword: process.env.ADMIN_PASSWORD,

  // Admin whitelist (wallets that can access admin panel) - NO DEFAULT
  adminWallets: (process.env.ADMIN_WALLETS || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean),

  // x402
  x402: {
    facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://facilitator.ultravioletadao.xyz',
    network: process.env.X402_NETWORK || 'avalanche',
    // Wallet receiver - NO DEFAULT FOR SECURITY
    receiverAddress: process.env.X402_RECEIVER_ADDRESS,
  },

  // Bingo - Production price: $5 USDC
  cardPrice: parseFloat(process.env.CARD_PRICE) || 5,
  maxCardsPerPurchase: 34, // Synced with frontend - max Fibonacci quantity

  // Valid Fibonacci quantities for purchase
  fibonacciQuantities: [1, 2, 3, 5, 8, 13, 21, 34],

  // Bingo card configuration
  bingoColumns: {
    B: { min: 1, max: 15 },
    I: { min: 16, max: 30 },
    N: { min: 31, max: 45 },
    G: { min: 46, max: 60 },
    O: { min: 61, max: 75 },
  },
};

export default config;
