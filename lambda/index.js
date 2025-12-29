// Ultra Bingo - Main API Lambda Handler
import { v4 as uuidv4 } from 'uuid';
import * as db from './lib/dynamodb.js';
import { getSecrets, isAdminWallet } from './lib/secrets.js';
import { generateToken, authenticateRequest, requireAuth, requireAdmin } from './lib/auth.js';

// =============================================================================
// x402 Payment Configuration
// =============================================================================

const USDC_ADDRESSES = {
  'avalanche': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const VALID_QUANTITIES = [1, 2, 3, 5, 8, 13, 21, 34];

// =============================================================================
// Response Helpers
// =============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGINS?.split(',')[0] || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Payment',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Payment-Required',
  'Content-Type': 'application/json',
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

function success(data) {
  return response(200, data);
}

function error(statusCode, message) {
  return response(statusCode, { error: message });
}

// =============================================================================
// x402 Payment Functions
// =============================================================================

function paymentRequired(quantity, secrets) {
  const network = secrets.X402_NETWORK || 'avalanche';
  const usdcAddress = USDC_ADDRESSES[network];
  const cardPrice = parseFloat(secrets.CARD_PRICE || '0.01');
  const price = quantity * cardPrice;
  const priceInAtomicUnits = Math.round(price * 1_000_000).toString();

  const paymentInfo = {
    x402Version: 1,
    scheme: 'exact',
    network: network,
    receiver: secrets.X402_RECEIVER_ADDRESS,
    amount: priceInAtomicUnits,
    asset: usdcAddress,
    description: `Purchase of ${quantity} bingo card(s)`,
    extra: {
      name: 'USD Coin',
      version: '2',
    },
  };

  return {
    statusCode: 402,
    headers: {
      ...corsHeaders,
      'X-Payment-Required': Buffer.from(JSON.stringify(paymentInfo)).toString('base64'),
    },
    body: JSON.stringify({
      x402Version: 1,
      paymentInfo: paymentInfo,
    }),
  };
}

/**
 * Verify payment with UltravioletaDAO facilitator
 * Calls both /verify and /settle endpoints
 */
async function verifyX402Payment(paymentHeader, quantity, secrets) {
  const network = secrets.X402_NETWORK || 'avalanche';
  const usdcAddress = USDC_ADDRESSES[network];
  const facilitatorUrl = (secrets.X402_FACILITATOR_URL || 'https://facilitator.ultravioletadao.xyz').replace(/\/$/, '');
  const cardPrice = parseFloat(secrets.CARD_PRICE || '0.01');
  const price = quantity * cardPrice;
  const maxAmountRequired = Math.round(price * 1_000_000).toString();

  console.log('[x402] Starting payment verification');
  console.log('[x402] Network:', network);
  console.log('[x402] Facilitator:', facilitatorUrl);
  console.log('[x402] Amount required:', maxAmountRequired);

  try {
    // Decode payment payload from frontend (base64 encoded JSON)
    let paymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      paymentPayload = JSON.parse(decoded);
      console.log('[x402] Decoded payload successfully');
    } catch (e) {
      console.error('[x402] Failed to decode payment header:', e.message);
      return { valid: false, error: 'Invalid payment header encoding' };
    }

    // Build paymentRequirements according to x402 spec
    const paymentRequirements = {
      scheme: 'exact',
      network: network,
      maxAmountRequired: maxAmountRequired,
      resource: 'bingo-card-purchase',
      description: `Purchase of ${quantity} bingo card(s)`,
      mimeType: 'application/json',
      payTo: secrets.X402_RECEIVER_ADDRESS,
      maxTimeoutSeconds: 60,
      asset: usdcAddress,
      extra: {
        name: 'USD Coin',
        version: '2',
      },
    };

    // Format for facilitator: { x402Version, paymentPayload, paymentRequirements }
    const verifyBody = {
      x402Version: 1,
      paymentPayload: paymentPayload,
      paymentRequirements: paymentRequirements,
    };

    console.log('[x402] Calling facilitator /verify...');

    // First verify the payment
    const verifyResponse = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyBody),
    });

    const verifyText = await verifyResponse.text();
    console.log('[x402] Verify response:', verifyResponse.status, verifyText.substring(0, 300));

    if (!verifyResponse.ok) {
      return { valid: false, error: `Verification failed: ${verifyText}` };
    }

    let verifyResult;
    try {
      verifyResult = JSON.parse(verifyText);
    } catch (e) {
      verifyResult = { raw: verifyText };
    }

    if (verifyResult.isValid === false || verifyResult.valid === false) {
      return { valid: false, error: verifyResult.invalidReason || verifyResult.reason || 'Payment invalid' };
    }

    // Now settle the payment (execute on-chain)
    console.log('[x402] Calling facilitator /settle...');

    const settleResponse = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyBody),
    });

    const settleText = await settleResponse.text();
    console.log('[x402] Settle response:', settleResponse.status, settleText.substring(0, 300));

    if (!settleResponse.ok) {
      return {
        valid: false,
        error: 'Payment settlement failed. Transaction was not executed on blockchain.',
        settled: false,
        verifyResult,
      };
    }

    let settleResult;
    try {
      settleResult = JSON.parse(settleText);
    } catch (e) {
      settleResult = { raw: settleText };
    }

    return {
      valid: true,
      settled: true,
      verifyResult,
      settleResult,
      transaction: settleResult.transaction || settleResult.txHash,
    };

  } catch (err) {
    console.error('[x402] Error:', err);
    return { valid: false, error: `Payment verification error: ${err.message}` };
  }
}

// =============================================================================
// Route Handler
// =============================================================================

export async function handler(event) {
  console.log('Event:', JSON.stringify(event));

  // Handle both API Gateway v1 and v2 formats
  const httpMethod = event.httpMethod || event.requestContext?.http?.method;
  const rawBody = event.body;

  // Handle CORS preflight
  if (httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  // Get path - v2 uses rawPath, v1 uses path
  let path = event.rawPath || event.path || '';

  // Strip stage name from path (e.g., /prod/health -> /health)
  const stage = event.requestContext?.stage;
  if (stage && path.startsWith(`/${stage}`)) {
    path = path.slice(stage.length + 1);
  }

  const body = rawBody ? JSON.parse(rawBody) : {};

  try {
    // Normalize path - remove /api prefix if present
    const normalizedPath = path.replace(/^\/api/, '');
    const route = `${httpMethod} ${normalizedPath}`;

    console.log('Route:', route);

    // Health check
    if (path === '/health' || normalizedPath === '/health') {
      return success({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Auth routes
    if (route === 'POST /auth/login' || route === 'POST /auth/wallet') return handleLogin(body);
    if (route === 'POST /auth/register') return handleRegister(body);
    if (route === 'GET /auth/me') return handleGetMe(event);

    // Card routes
    if (route === 'GET /cards/available') return handleGetAvailableCards();
    if (route === 'GET /cards/my-cards') return handleGetMyCards(event);
    if (route === 'POST /cards/purchase') return handlePurchaseCards(event, body);

    // Game routes
    if (route === 'GET /game/state' || route === 'GET /game/current') return handleGetGameState();
    if (route === 'GET /game/status') return handleGetGameState();
    if (route === 'GET /game/modes') return handleGetGameModes();
    if (route.startsWith('GET /game/winners')) return handleGetWinners(event);

    // Admin routes
    if (route === 'GET /admin/users') return handleGetUsers(event);
    if (route === 'GET /admin/stats') return handleGetStats(event);
    if (route === 'GET /admin/cards/active') return handleGetActiveCards(event);
    if (route === 'GET /admin/validate') return handleValidateAdmin(event);
    if (route === 'POST /admin/game/start') return handleStartGame(event);
    if (route === 'POST /admin/game/call') return handleCallNumber(event, body);
    if (route === 'POST /admin/game/verify') return handleVerifyWinner(event, body);
    if (route === 'POST /admin/game/end') return handleResetGame(event);
    if (route === 'POST /admin/game/mode') return handleSetGameMode(event, body);
    if (route === 'POST /admin/cards/generate') return handleGenerateCards(event, body);

    return error(404, 'Not found');
  } catch (err) {
    console.error('Handler error:', err);

    if (err.statusCode) {
      return error(err.statusCode, err.message);
    }

    return error(500, 'Internal server error');
  }
}

// =============================================================================
// Auth Handlers
// =============================================================================

async function handleLogin(body) {
  const { wallet, signature } = body;

  if (!wallet) {
    return error(400, 'Wallet address required');
  }

  // Find or create user
  let user = await db.getUserByWallet(wallet);

  if (!user) {
    // Auto-register on first login
    const secrets = await getSecrets();
    const odId = `od_${uuidv4().slice(0, 8)}`;
    const isAdmin = isAdminWallet(wallet, secrets.ADMIN_WALLETS);

    user = await db.createUser({
      odId,
      username: `User_${wallet.slice(-6)}`,
      wallet: wallet.toLowerCase(),
      isAdmin,
    });
  }

  const token = await generateToken(user);

  return success({
    user: {
      odId: user.odId,
      username: user.username,
      wallet: user.wallet,
      isAdmin: user.isAdmin,
      stats: user.stats,
    },
    token,
  });
}

async function handleRegister(body) {
  const { wallet, username } = body;

  if (!wallet || !username) {
    return error(400, 'Wallet and username required');
  }

  // Check if wallet already exists - if so, just log them in
  const existingUser = await db.getUserByWallet(wallet);
  if (existingUser) {
    const token = await generateToken(existingUser);
    return success({
      user: {
        odId: existingUser.odId,
        username: existingUser.username,
        wallet: existingUser.wallet,
        isAdmin: existingUser.isAdmin,
        stats: existingUser.stats,
      },
      token,
    });
  }

  const secrets = await getSecrets();
  const odId = `od_${uuidv4().slice(0, 8)}`;
  const isAdmin = isAdminWallet(wallet, secrets.ADMIN_WALLETS);

  const user = await db.createUser({
    odId,
    username,
    wallet: wallet.toLowerCase(),
    isAdmin,
  });

  const token = await generateToken(user);

  return success({
    user: {
      odId: user.odId,
      username: user.username,
      wallet: user.wallet,
      isAdmin: user.isAdmin,
      stats: user.stats,
    },
    token,
  });
}

async function handleGetMe(event) {
  const user = await requireAuth(event);
  const fullUser = await db.getUserById(user.odId);

  if (!fullUser) {
    return error(404, 'User not found');
  }

  return success({
    odId: fullUser.odId,
    username: fullUser.username,
    wallet: fullUser.wallet,
    isAdmin: fullUser.isAdmin,
    stats: fullUser.stats,
  });
}

// =============================================================================
// Card Handlers
// =============================================================================

async function handleGetAvailableCards() {
  const cards = await db.getAvailableCards(50);

  return success({
    cards: cards.map(c => ({
      id: c.cardId,
      numbers: c.numbers,
      status: c.status,
    })),
    count: cards.length,
    total: cards.length,
  });
}

async function handleGetMyCards(event) {
  const user = await requireAuth(event);
  const cards = await db.getCardsByOwner(user.odId);

  return success({
    cards: cards.map(c => ({
      id: c.cardId,
      numbers: c.numbers,
      status: c.status,
      purchasedAt: c.purchasedAt,
    })),
    count: cards.length,
  });
}

async function handlePurchaseCards(event, body) {
  const user = await requireAuth(event);
  const { quantity, wallet } = body;
  const secrets = await getSecrets();

  // Validate quantity is a Fibonacci number
  if (!quantity || typeof quantity !== 'number') {
    return error(400, 'Quantity is required and must be a number');
  }

  if (!VALID_QUANTITIES.includes(quantity)) {
    return error(400, `Invalid quantity. Must be a Fibonacci number: ${VALID_QUANTITIES.join(', ')}`);
  }

  // Block manual cardIds selection for security
  if (body.cardIds) {
    return error(400, 'Manual card selection is not allowed. Use quantity parameter.');
  }

  // Check for x402 payment header
  const paymentHeader = event.headers?.['x-payment'] ||
                        event.headers?.['X-Payment'] ||
                        event.headers?.['payment-signature'];

  if (!paymentHeader) {
    // No payment - return 402 Payment Required
    console.log('No payment header, returning 402');
    return paymentRequired(quantity, secrets);
  }

  // Verify payment with UltravioletaDAO facilitator
  console.log('Verifying x402 payment with facilitator...');
  const paymentResult = await verifyX402Payment(paymentHeader, quantity, secrets);

  if (!paymentResult.valid) {
    console.log('Payment verification failed:', paymentResult.error);
    return {
      statusCode: 402,
      headers: corsHeaders,
      body: JSON.stringify({
        x402Version: 1,
        error: 'Payment verification failed',
        message: paymentResult.error || 'Invalid payment',
      }),
    };
  }

  const txHash = paymentResult.transaction;
  if (!txHash) {
    console.log('No transaction hash from facilitator');
    return error(402, 'Payment transaction not confirmed');
  }

  console.log('Payment verified and settled, txHash:', txHash);

  // Get available cards
  const availableCards = await db.getAvailableCards(quantity);
  if (availableCards.length < quantity) {
    return error(400, `Not enough cards available. Requested: ${quantity}, Available: ${availableCards.length}`);
  }

  const selectedCardIds = availableCards.slice(0, quantity).map(c => c.cardId);
  const fullUser = await db.getUserById(user.odId);

  // Reserve cards first
  const reserved = await db.reserveCards(selectedCardIds, user.odId);

  if (reserved.length === 0) {
    return error(400, 'No cards available to purchase');
  }

  if (reserved.length < quantity) {
    // Release partial reservation
    await db.releaseReservation(reserved.map(c => c.cardId), user.odId);
    return error(409, `Only ${reserved.length} of ${quantity} cards were available. Please try again.`);
  }

  // Confirm the reservation with verified payment
  const confirmed = await db.confirmReservation(
    reserved.map(c => c.cardId),
    user.odId,
    wallet || user.wallet,
    txHash,
    secrets.CARD_PRICE,
    fullUser?.username
  );

  // Update user stats
  if (confirmed.length > 0) {
    const totalSpent = BigInt(fullUser?.stats?.totalSpent || '0') +
                       BigInt(Math.floor(parseFloat(secrets.CARD_PRICE) * 1000000 * confirmed.length));

    await db.updateUserStats(user.odId, {
      cardsPurchased: (fullUser?.stats?.cardsPurchased || 0) + confirmed.length,
      totalSpent: totalSpent.toString(),
    });

    // Update game prize pool
    const game = await db.getCurrentGame();
    if (game) {
      const newPrizePool = BigInt(game.prizePool || '0') +
                           BigInt(Math.floor(parseFloat(secrets.CARD_PRICE) * 1000000 * confirmed.length));
      await db.updateGame({
        prizePool: newPrizePool.toString(),
        cardsSold: (game.cardsSold || 0) + confirmed.length,
      });
    }
  }

  return success({
    success: true,
    cards: confirmed.map(c => ({
      id: c.id,
      numbers: c.numbers,
    })),
    message: `Successfully purchased ${confirmed.length} cards`,
    transaction: txHash,
  });
}

// =============================================================================
// Game Handlers
// =============================================================================

async function handleGetGameState() {
  let game = await db.getCurrentGame();

  if (!game) {
    game = await db.createGame({});
  }

  return success({
    gameId: game.gameId,
    status: game.status,
    gameMode: game.gameMode,
    calledNumbers: game.calledNumbers,
    currentNumber: game.currentNumber,
    cardsSold: game.cardsSold,
    prizePool: game.prizePool,
    winner: game.winner,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
  });
}

// =============================================================================
// Admin Handlers
// =============================================================================

async function handleStartGame(event) {
  await requireAdmin(event);

  const game = await db.getCurrentGame();

  if (!game) {
    return error(400, 'No game exists');
  }

  if (game.status === 'playing') {
    return error(400, 'Game already in progress');
  }

  await db.updateGame({
    status: 'playing',
    startedAt: new Date().toISOString(),
  });

  return success({ message: 'Game started' });
}

async function handleCallNumber(event, body) {
  await requireAdmin(event);

  const { number } = body;

  if (!number || number < 1 || number > 75) {
    return error(400, 'Invalid number (1-75)');
  }

  const game = await db.getCurrentGame();

  if (!game || game.status !== 'playing') {
    return error(400, 'Game is not in playing state');
  }

  if (game.calledNumbers.includes(number)) {
    return error(400, 'Number already called');
  }

  const newCalledNumbers = [...game.calledNumbers, number];

  await db.updateGame({
    calledNumbers: newCalledNumbers,
    currentNumber: number,
  });

  return success({
    number,
    calledNumbers: newCalledNumbers,
    totalCalled: newCalledNumbers.length,
  });
}

async function handleVerifyWinner(event, body) {
  await requireAdmin(event);

  const { cardId, odId } = body;

  if (!cardId || !odId) {
    return error(400, 'Card ID and user ID required');
  }

  const game = await db.getCurrentGame();
  if (!game || game.status !== 'playing') {
    return error(400, 'Game is not in playing state');
  }

  // Get the card
  const cards = await db.getCardsByOwner(odId);
  const card = cards.find(c => c.cardId === cardId);

  if (!card) {
    return error(400, 'Card not found or not owned by user');
  }

  // Verify the winning pattern (simplified - full card check)
  const calledSet = new Set(game.calledNumbers);
  let isWinner = true;

  for (const column of Object.values(card.numbers)) {
    for (const num of column) {
      if (num !== 0 && !calledSet.has(num)) {
        isWinner = false;
        break;
      }
    }
    if (!isWinner) break;
  }

  if (!isWinner) {
    return error(400, 'Card does not have a winning pattern');
  }

  // Get winner user
  const user = await db.getUserById(odId);

  // End the game
  await db.updateGame({
    status: 'ended',
    endedAt: new Date().toISOString(),
    winner: {
      odId: user.odId,
      odUsername: user.username,
      wallet: user.wallet,
      cardId: card.cardId,
      prizeAmount: game.prizePool,
    },
  });

  // Update user stats
  await db.updateUserStats(odId, {
    gamesWon: (user.stats?.gamesWon || 0) + 1,
    totalWon: (BigInt(user.stats?.totalWon || '0') + BigInt(game.prizePool)).toString(),
  });

  return success({
    winner: {
      odId: user.odId,
      username: user.username,
      wallet: user.wallet,
      cardId: card.cardId,
      prizeAmount: game.prizePool,
    },
  });
}

async function handleResetGame(event) {
  await requireAdmin(event);

  // Create a new game
  const newGame = await db.createGame({
    gameId: `game_${Date.now()}`,
  });

  return success({
    message: 'Game reset',
    gameId: newGame.gameId,
  });
}

async function handleSetGameMode(event, body) {
  await requireAdmin(event);

  const { gameMode } = body;
  const validModes = ['fullCard', 'letterU', 'letterL', 'letterT', 'letterR', 'letterA', 'line', 'corners'];

  if (!validModes.includes(gameMode)) {
    return error(400, 'Invalid game mode');
  }

  const game = await db.getCurrentGame();

  if (game?.status === 'playing') {
    return error(400, 'Cannot change mode while game is in progress');
  }

  await db.updateGame({ gameMode });

  return success({ gameMode });
}

// =============================================================================
// Game Info Handlers
// =============================================================================

async function handleGetGameModes() {
  const modes = [
    { id: 'fullCard', name: 'Cartón Completo', description: 'Llena todo el cartón' },
    { id: 'line', name: 'Línea', description: 'Una línea horizontal, vertical o diagonal' },
    { id: 'corners', name: 'Esquinas', description: 'Las 4 esquinas del cartón' },
    { id: 'letterU', name: 'Letra U', description: 'Forma de U' },
    { id: 'letterL', name: 'Letra L', description: 'Forma de L' },
    { id: 'letterT', name: 'Letra T', description: 'Forma de T' },
  ];

  return success({ modes });
}

async function handleGetWinners(event) {
  // Parse query parameters
  const queryParams = event.queryStringParameters || {};
  const limit = parseInt(queryParams.limit) || 10;

  // For now, return empty array - winners would be stored in a separate table
  // In a full implementation, this would query a winners history table
  return success({ winners: [], count: 0 });
}

// =============================================================================
// Card Generation
// =============================================================================

function generateBingoCard() {
  const numbers = {
    B: [],
    I: [],
    N: [],
    G: [],
    O: [],
  };

  // B: 1-15, I: 16-30, N: 31-45, G: 46-60, O: 61-75
  const ranges = {
    B: [1, 15],
    I: [16, 30],
    N: [31, 45],
    G: [46, 60],
    O: [61, 75],
  };

  for (const [letter, [min, max]] of Object.entries(ranges)) {
    const available = [];
    for (let i = min; i <= max; i++) available.push(i);

    // Shuffle and pick 5
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    numbers[letter] = available.slice(0, 5);
  }

  // Free space in center (N column, index 2)
  numbers.N[2] = 0;

  return numbers;
}

async function handleGenerateCards(event, body) {
  await requireAdmin(event);

  const { count = 50 } = body;
  const maxCount = Math.min(count, 200); // Limit to 200 cards at a time

  const generatedCards = [];

  for (let i = 0; i < maxCount; i++) {
    const cardId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const numbers = generateBingoCard();

    const card = await db.createCard({
      cardId,
      numbers,
    });

    generatedCards.push({
      id: card.cardId,
      numbers: card.numbers,
    });
  }

  return success({
    message: `Generated ${generatedCards.length} cards`,
    count: generatedCards.length,
  });
}

// =============================================================================
// Additional Admin Handlers
// =============================================================================

async function handleGetUsers(event) {
  await requireAdmin(event);

  const users = await db.getAllUsers();

  return success({
    users: users.map(u => ({
      odId: u.odId,
      username: u.username,
      wallet: u.wallet,
      isAdmin: u.isAdmin || false,
      createdAt: u.createdAt,
      cardsPurchased: u.stats?.cardsPurchased || 0,
      gamesPlayed: u.stats?.gamesPlayed || 0,
      gamesWon: u.stats?.gamesWon || 0,
    })),
    total: users.length,
  });
}

async function handleGetStats(event) {
  await requireAdmin(event);

  const game = await db.getCurrentGame();
  const availableCards = await db.getAvailableCards(1000);
  const users = await db.getAllUsers();

  return success({
    game: {
      status: game?.status || 'idle',
      gameMode: game?.gameMode || 'fullCard',
      calledNumbers: game?.calledNumbers?.length || 0,
      startedAt: game?.startedAt,
      prizePool: game?.prizePool || '0',
      cardsSold: game?.cardsSold || 0,
    },
    cards: {
      available: availableCards.length,
    },
    users: {
      total: users.length,
    },
  });
}

async function handleGetActiveCards(event) {
  await requireAdmin(event);

  const purchasedCards = await db.getAllPurchasedCards();
  const game = await db.getCurrentGame();
  const calledNumbers = game?.calledNumbers || [];

  return success({
    cards: purchasedCards.map(card => ({
      id: card.cardId,
      numbers: card.numbers,
      owner: card.owner,
      ownerUsername: card.ownerUsername,
      ownerWallet: card.ownerWallet,
    })),
    total: purchasedCards.length,
    gameMode: game?.gameMode || 'fullCard',
    calledNumbers,
  });
}

async function handleValidateAdmin(event) {
  await requireAdmin(event);
  return success({ valid: true });
}
