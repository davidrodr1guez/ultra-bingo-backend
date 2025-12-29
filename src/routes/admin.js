import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { generateToken } from '../middleware/auth.js';
// SECURITY: Use verifyAdminStrict which validates BOTH isAdmin AND wallet whitelist
import { rateLimit, auditLog, verifyAdminStrict } from '../middleware/security.js';
import { config } from '../config/index.js';
import gameState from '../services/gameState.js';
import { generateMultipleCards, checkWinner } from '../services/bingoCard.js';

const router = Router();

// SECURITY: Pre-hash admin password at module load
let adminPasswordHash = null;
(async () => {
  adminPasswordHash = await bcrypt.hash(config.adminPassword, 10);
})();

/**
 * POST /api/admin/login
 * Admin login with wallet requirement
 * SECURITY: Rate limited to prevent brute force
 */
router.post('/login', rateLimit('login'), async (req, res) => {
  try {
    const { password, wallet } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    // SECURITY: Wallet is required for admin login
    if (!wallet) {
      auditLog({
        action: 'ADMIN_LOGIN_FAILED',
        reason: 'No wallet provided',
        ip: req.ip,
      });
      return res.status(400).json({ error: 'Wallet address required for admin login' });
    }

    // Normalize wallet address
    const normalizedWallet = wallet.toLowerCase();

    // SECURITY: Verify wallet is in admin whitelist
    if (!config.adminWallets.includes(normalizedWallet)) {
      auditLog({
        action: 'ADMIN_LOGIN_FAILED',
        reason: 'Wallet not in whitelist',
        wallet: normalizedWallet,
        ip: req.ip,
      });
      return res.status(403).json({ error: 'Wallet not authorized for admin access' });
    }

    // Ensure hash is ready
    if (!adminPasswordHash) {
      adminPasswordHash = await bcrypt.hash(config.adminPassword, 10);
    }

    // Verify password
    const isValid = await bcrypt.compare(password, adminPasswordHash);

    if (!isValid) {
      auditLog({
        action: 'ADMIN_LOGIN_FAILED',
        reason: 'Invalid password',
        wallet: normalizedWallet,
        ip: req.ip,
      });
      return res.status(401).json({ error: 'Invalid password' });
    }

    // SECURITY: Generate admin token WITH wallet for socket verification
    const token = generateToken({
      isAdmin: true,
      userId: 'admin',
      wallet: normalizedWallet, // CRITICAL: Include wallet for socket auth
    });

    auditLog({
      action: 'ADMIN_LOGIN_SUCCESS',
      wallet: normalizedWallet,
      ip: req.ip,
    });

    res.json({
      success: true,
      token,
    });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/admin/validate
 * Validate admin token
 */
router.get('/validate', verifyAdminStrict, (req, res) => {
  res.json({ valid: true });
});

/**
 * POST /api/admin/game/start
 * Start a new game
 */
router.post('/game/start', verifyAdminStrict, async (req, res) => {
  try {
    const state = await gameState.startGame();
    const io = req.app.get('io');
    io.emit('game-started', state);
    io.emit('game-state', state);
    res.json({ success: true, state });
  } catch (error) {
    console.error('Error starting game:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

/**
 * POST /api/admin/game/pause
 * Pause the game
 */
router.post('/game/pause', verifyAdminStrict, async (req, res) => {
  try {
    const state = await gameState.pauseGame();
    const io = req.app.get('io');
    io.emit('game-paused', state);
    io.emit('game-state', state);
    res.json({ success: true, state });
  } catch (error) {
    console.error('Error pausing game:', error);
    res.status(500).json({ error: 'Failed to pause game' });
  }
});

/**
 * POST /api/admin/game/resume
 * Resume the game
 */
router.post('/game/resume', verifyAdminStrict, async (req, res) => {
  try {
    const state = await gameState.resumeGame();
    const io = req.app.get('io');
    io.emit('game-resumed', state);
    io.emit('game-state', state);
    res.json({ success: true, state });
  } catch (error) {
    console.error('Error resuming game:', error);
    res.status(500).json({ error: 'Failed to resume game' });
  }
});

/**
 * POST /api/admin/game/end
 * End the game
 */
router.post('/game/end', verifyAdminStrict, async (req, res) => {
  try {
    const { winner } = req.body;
    const state = await gameState.endGame(winner);
    const io = req.app.get('io');
    io.emit('game-ended', state);
    io.emit('game-state', state);
    res.json({ success: true, state });
  } catch (error) {
    console.error('Error ending game:', error);
    res.status(500).json({ error: 'Failed to end game' });
  }
});

/**
 * POST /api/admin/game/call
 * Call a number
 */
router.post('/game/call', verifyAdminStrict, async (req, res) => {
  try {
    const { number } = req.body;

    if (typeof number !== 'number' || number < 1 || number > 75) {
      return res.status(400).json({ error: 'Invalid number (1-75)' });
    }

    const state = await gameState.callNumber(number);
    const io = req.app.get('io');

    io.emit('number-called', {
      number,
      calledNumbers: state.calledNumbers,
    });
    io.emit('game-state', state);

    res.json({ success: true, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/admin/game/verify
 * Verify a winner
 */
router.post('/game/verify', verifyAdminStrict, async (req, res) => {
  try {
    const { cardId } = req.body;

    if (!cardId) {
      return res.status(400).json({ error: 'Card ID required' });
    }

    const purchasedCard = await gameState.getPurchasedCard(cardId);

    if (!purchasedCard) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const calledNumbers = await gameState.getCalledNumbers();
    const result = checkWinner(purchasedCard.card, calledNumbers);

    if (result.isWinner) {
      // SECURITY: Winner structure matching Game model schema (consistent with socket.js)
      const winner = {
        odId: purchasedCard.owner,
        odUsername: purchasedCard.ownerUsername,
        wallet: purchasedCard.ownerWallet,
        cardId,
        prizeAmount: '0', // TODO: Calculate from prize pool
        pattern: result.pattern,
        verifiedAt: new Date().toISOString(),
      };

      auditLog({
        action: 'WINNER_VERIFIED_API',
        cardId,
        owner: purchasedCard.owner,
        pattern: result.pattern,
      });

      const state = await gameState.endGame(winner);
      const io = req.app.get('io');

      io.emit('winner-announced', { winner });
      io.emit('game-ended', state);
      io.emit('game-state', state);

      res.json({ success: true, winner, state });
    } else {
      res.json({ success: false, message: 'Not a winning card' });
    }
  } catch (error) {
    console.error('Error verifying winner:', error);
    res.status(500).json({ error: 'Failed to verify winner' });
  }
});

/**
 * POST /api/admin/cards/generate
 * Generate more available cards
 * SECURITY: Rate limited to prevent abuse, max 50 cards per request
 */
router.post('/cards/generate', verifyAdminStrict, rateLimit('adminAction'), async (req, res) => {
  try {
    const { count = 50 } = req.body;
    // SECURITY: Strict limit - max 50 cards per request to prevent abuse
    const limitedCount = Math.min(Math.max(1, parseInt(count) || 50), 50);

    auditLog({
      action: 'CARDS_GENERATED',
      count: limitedCount,
      requestedCount: count,
      ip: req.ip,
    });

    const cards = generateMultipleCards(limitedCount);
    await gameState.addAvailableCards(cards);

    const availableCards = await gameState.getAvailableCards();

    res.json({
      success: true,
      generated: cards.length,
      totalAvailable: availableCards.length,
    });
  } catch (error) {
    console.error('Error generating cards:', error.message);
    res.status(500).json({ error: 'Failed to generate cards' });
  }
});

/**
 * GET /api/admin/stats
 * Get game statistics
 */
router.get('/stats', verifyAdminStrict, async (req, res) => {
  try {
    const state = await gameState.getGameState();
    const availableCards = await gameState.getAvailableCards();
    const purchasedCards = await gameState.getAllPurchasedCards();

    res.json({
      game: {
        status: state.status,
        gameMode: state.gameMode,
        calledNumbers: state.calledNumbers.length,
        startedAt: state.startedAt,
        canPurchase: state.canPurchase,
      },
      cards: {
        available: availableCards.length,
        purchased: purchasedCards.length,
      },
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============== GAME MODE MANAGEMENT ==============

/**
 * GET /api/admin/game/modes
 * Get all available game modes
 */
router.get('/game/modes', verifyAdminStrict, (req, res) => {
  try {
    const patterns = gameState.getAvailablePatterns();
    const modes = Object.entries(patterns).map(([key, pattern]) => ({
      key,
      name: pattern.name,
      description: pattern.description,
      positions: pattern.positions,
      isSpecialPattern: pattern.isSpecialPattern || false,
    }));

    res.json({ modes });
  } catch (error) {
    console.error('Error getting game modes:', error);
    res.status(500).json({ error: 'Failed to get game modes' });
  }
});

/**
 * POST /api/admin/game/mode
 * Set game mode (only when game not in progress)
 */
router.post('/game/mode', verifyAdminStrict, async (req, res) => {
  try {
    const { mode } = req.body;

    if (!mode) {
      return res.status(400).json({ error: 'Game mode is required' });
    }

    const state = await gameState.setGameMode(mode);
    const io = req.app.get('io');

    // Emit mode change to all clients
    io.emit('game-mode-changed', {
      gameMode: state.gameMode,
      patternInfo: gameState.getPatternInfoForMode(state.gameMode),
    });
    io.emit('game-state', state);

    auditLog({
      action: 'GAME_MODE_CHANGED',
      mode,
      ip: req.ip,
    });

    res.json({
      success: true,
      state,
      patternInfo: gameState.getPatternInfoForMode(state.gameMode),
    });
  } catch (error) {
    console.error('Error setting game mode:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============== CARD SEARCH AND MANAGEMENT ==============

/**
 * GET /api/admin/cards/search
 * Search for a card by ID (supports partial ID search)
 */
router.get('/cards/search', verifyAdminStrict, async (req, res) => {
  try {
    const { cardId, wallet, owner } = req.query;

    if (!cardId && !wallet && !owner) {
      return res.status(400).json({
        error: 'At least one search parameter required (cardId, wallet, or owner)',
      });
    }

    let card = null;

    if (cardId) {
      // SECURITY: Sanitize cardId to prevent ReDoS (regex denial of service)
      // Only allow alphanumeric, hyphens, and underscores
      const sanitizedCardId = cardId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (sanitizedCardId.length < 4 || sanitizedCardId.length > 50) {
        return res.status(400).json({ error: 'Invalid card ID format' });
      }

      // First try exact match
      card = await gameState.getPurchasedCard(cardId);

      // If not found, try partial match (search by partial ID)
      if (!card) {
        const { default: Card } = await import('../models/Card.js');
        // SECURITY: Escape regex special characters and use sanitized input
        const escapedCardId = sanitizedCardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const partialMatch = await Card.findOne({
          cardId: { $regex: escapedCardId, $options: 'i' },
          status: 'purchased',
        });

        if (partialMatch) {
          card = {
            card: { id: partialMatch.cardId, numbers: partialMatch.numbers },
            owner: partialMatch.owner,
            ownerUsername: partialMatch.ownerUsername,
            ownerWallet: partialMatch.ownerWallet,
            purchasedAt: partialMatch.purchasedAt,
            txHash: partialMatch.purchaseTxHash,
          };
        }
      }
    }

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    // Get current game state for progress calculation
    const state = await gameState.getGameState();
    const { getPatternProgress } = await import('../services/bingoCard.js');
    const progress = getPatternProgress(card.card, state.calledNumbers, state.gameMode);

    // Check if card is winner
    const { checkWinner } = await import('../services/bingoCard.js');
    const winnerCheck = checkWinner(card.card, state.calledNumbers, state.gameMode);

    res.json({
      card: {
        id: card.card.id,
        numbers: card.card.numbers,
        owner: card.owner,
        ownerUsername: card.ownerUsername,
        ownerWallet: card.ownerWallet,
        purchasedAt: card.purchasedAt,
        txHash: card.txHash,
      },
      progress,
      isWinner: winnerCheck.isWinner,
      winnerPattern: winnerCheck.pattern,
      gameMode: state.gameMode,
      calledNumbers: state.calledNumbers,
    });
  } catch (error) {
    console.error('Error searching card:', error);
    res.status(500).json({ error: 'Failed to search card' });
  }
});

/**
 * GET /api/admin/cards/active
 * Get all active (purchased) cards
 */
router.get('/cards/active', verifyAdminStrict, async (req, res) => {
  try {
    const purchasedCards = await gameState.getAllPurchasedCards();
    const state = await gameState.getGameState();
    const { getPatternProgress, checkWinner } = await import('../services/bingoCard.js');

    // Calculate progress for each card
    const cardsWithProgress = purchasedCards.map(card => {
      const progress = getPatternProgress(card.card, state.calledNumbers, state.gameMode);
      const winnerCheck = checkWinner(card.card, state.calledNumbers, state.gameMode);

      return {
        id: card.card.id,
        numbers: card.card.numbers,
        owner: card.owner,
        ownerUsername: card.ownerUsername,
        ownerWallet: card.ownerWallet,
        progress,
        isWinner: winnerCheck.isWinner,
      };
    });

    // Sort by progress (closest to winning first)
    cardsWithProgress.sort((a, b) => b.progress.percentage - a.progress.percentage);

    res.json({
      cards: cardsWithProgress,
      total: cardsWithProgress.length,
      gameMode: state.gameMode,
      calledNumbers: state.calledNumbers,
    });
  } catch (error) {
    console.error('Error getting active cards:', error);
    res.status(500).json({ error: 'Failed to get active cards' });
  }
});

// ============== USER MANAGEMENT (ADMIN ONLY) ==============

/**
 * GET /api/admin/users
 * Get all registered users (admin only)
 * SECURITY: Only accessible by whitelisted admin wallets
 */
router.get('/users', verifyAdminStrict, async (req, res) => {
  try {
    const { default: User } = await import('../models/User.js');

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const users = await User.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('odId username wallet isAdmin createdAt lastLoginAt stats')
      .lean();

    auditLog({
      action: 'ADMIN_VIEW_USERS',
      count: users.length,
      ip: req.ip,
    });

    res.json({
      users: users.map(u => ({
        odId: u.odId,
        username: u.username,
        wallet: u.wallet,
        isAdmin: u.isAdmin || false,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        cardsPurchased: u.stats?.cardsPurchased || 0,
        gamesPlayed: u.stats?.gamesPlayed || 0,
        gamesWon: u.stats?.gamesWon || 0,
      })),
      total: users.length,
    });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * POST /api/admin/game/reset
 * Reset game state (clear called numbers, winner, set to waiting)
 */
router.post('/game/reset', verifyAdminStrict, async (req, res) => {
  try {
    const state = await gameState.clearGame();
    const io = req.app.get('io');

    auditLog({
      action: 'GAME_RESET',
      ip: req.ip,
    });

    io.emit('game-reset', state);
    io.emit('game-state', state);

    res.json({
      success: true,
      message: 'Game reset successfully',
      state,
    });
  } catch (error) {
    console.error('Error resetting game:', error);
    res.status(500).json({ error: 'Failed to reset game' });
  }
});

/**
 * POST /api/admin/cards/reset
 * Reset all cards (delete purchased, regenerate available)
 */
router.post('/cards/reset', verifyAdminStrict, async (req, res) => {
  try {
    const { keepAvailable = false, generateCount = 100 } = req.body;

    const result = await gameState.resetAllCards(keepAvailable, generateCount);

    auditLog({
      action: 'CARDS_RESET',
      keepAvailable,
      generateCount,
      deletedPurchased: result.deletedPurchased,
      ip: req.ip,
    });

    res.json({
      success: true,
      message: 'Cards reset successfully',
      ...result,
    });
  } catch (error) {
    console.error('Error resetting cards:', error);
    res.status(500).json({ error: 'Failed to reset cards' });
  }
});

/**
 * POST /api/admin/full-reset
 * Full reset - reset game AND all cards
 */
router.post('/full-reset', verifyAdminStrict, async (req, res) => {
  try {
    const { generateCount = 100 } = req.body;

    const result = await gameState.fullReset(generateCount);
    const io = req.app.get('io');

    auditLog({
      action: 'FULL_RESET',
      generateCount,
      ip: req.ip,
    });

    io.emit('game-reset', result.game);
    io.emit('game-state', result.game);

    res.json({
      success: true,
      message: 'Full reset completed successfully',
      ...result,
    });
  } catch (error) {
    console.error('Error performing full reset:', error);
    res.status(500).json({ error: 'Failed to perform full reset' });
  }
});

/**
 * GET /api/admin/cards/:cardId/details
 * Get detailed info for a specific card
 */
router.get('/cards/:cardId/details', verifyAdminStrict, async (req, res) => {
  try {
    const { cardId } = req.params;
    const card = await gameState.getPurchasedCard(cardId);

    if (!card) {
      return res.status(404).json({ error: 'Card not found' });
    }

    const state = await gameState.getGameState();
    const { getPatternProgress, checkWinner, getPatternInfo } = await import('../services/bingoCard.js');

    const progress = getPatternProgress(card.card, state.calledNumbers, state.gameMode);
    const winnerCheck = checkWinner(card.card, state.calledNumbers, state.gameMode);
    const patternInfo = getPatternInfo(state.gameMode);

    // Create marked numbers grid for visualization
    const calledSet = new Set(state.calledNumbers);
    const markedNumbers = {};
    for (const col of ['B', 'I', 'N', 'G', 'O']) {
      markedNumbers[col] = card.card.numbers[col].map(num =>
        num === 0 || calledSet.has(num)
      );
    }

    res.json({
      card: {
        id: card.card.id,
        numbers: card.card.numbers,
        markedNumbers,
        owner: card.owner,
        ownerUsername: card.ownerUsername,
        ownerWallet: card.ownerWallet,
        purchasedAt: card.purchasedAt,
        txHash: card.txHash,
      },
      progress,
      isWinner: winnerCheck.isWinner,
      winnerPattern: winnerCheck.pattern,
      patternInfo,
      gameMode: state.gameMode,
      calledNumbers: state.calledNumbers,
      gameStatus: state.status,
    });
  } catch (error) {
    console.error('Error getting card details:', error);
    res.status(500).json({ error: 'Failed to get card details' });
  }
});

export default router;
