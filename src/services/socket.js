import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import gameState from './gameState.js';
import bingoCard from './bingoCard.js';
import { auditLog } from '../middleware/security.js';

// SECURITY: Rate limiting for socket events
const socketRateLimits = new Map();
const SOCKET_RATE_LIMITS = {
  'admin:call-number': { windowMs: 1000, maxRequests: 3 }, // 3 calls per second max
  'admin:uncall-number': { windowMs: 1000, maxRequests: 3 }, // 3 uncalls per second max
  'admin:start-game': { windowMs: 5000, maxRequests: 1 },  // 1 per 5 seconds
  'admin:end-game': { windowMs: 5000, maxRequests: 1 },
  'admin:verify-winner': { windowMs: 2000, maxRequests: 2 },
  'admin:reject-winner': { windowMs: 2000, maxRequests: 2 },
  'default': { windowMs: 1000, maxRequests: 10 },
};

function checkSocketRateLimit(socketId, eventName) {
  const limits = SOCKET_RATE_LIMITS[eventName] || SOCKET_RATE_LIMITS.default;
  const key = `${socketId}:${eventName}`;
  const now = Date.now();

  let data = socketRateLimits.get(key);
  if (!data || now - data.windowStart > limits.windowMs) {
    data = { windowStart: now, requests: 1 };
    socketRateLimits.set(key, data);
    return true;
  }

  data.requests++;
  if (data.requests > limits.maxRequests) {
    return false;
  }
  return true;
}

// Clean up rate limit data periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of socketRateLimits.entries()) {
    if (now - data.windowStart > 60000) {
      socketRateLimits.delete(key);
    }
  }
}, 60000);

/**
 * Setup Socket.io event handlers
 * @param {Server} io - Socket.io server instance
 */
export function setupSocketHandlers(io) {
  // Authentication middleware for sockets - SECURITY HARDENED
  io.use((socket, next) => {
    // CRITICAL: Explicitly set isAdmin to false by default
    socket.isAdmin = false;
    socket.userId = null;
    socket.authenticated = false;

    const token = socket.handshake.auth?.token;

    if (!token) {
      // Anonymous connection allowed for viewing only
      console.log(`[Socket Auth] Anonymous connection: ${socket.id}`);
      return next();
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret);

      // SECURITY: Validate token structure strictly
      if (!decoded || typeof decoded !== 'object') {
        console.warn(`[Socket Auth] Invalid token structure: ${socket.id}`);
        auditLog({
          action: 'SOCKET_INVALID_TOKEN_STRUCTURE',
          socketId: socket.id,
        });
        return next();
      }

      // SECURITY: Validate userId format to prevent injection
      const userId = decoded.userId || decoded.sub || null;
      if (userId && typeof userId === 'string' && userId.length > 100) {
        console.warn(`[Socket Auth] UserId too long: ${socket.id}`);
        return next();
      }

      socket.userId = userId;
      socket.wallet = decoded.wallet?.toLowerCase() || null;
      socket.authenticated = true;

      // SECURITY: Only grant admin if token explicitly has isAdmin AND wallet is in whitelist
      if (decoded.isAdmin === true) {
        const wallet = decoded.wallet?.toLowerCase();
        const isWhitelisted = wallet && config.adminWallets.includes(wallet);

        if (isWhitelisted) {
          socket.isAdmin = true;
          auditLog({
            action: 'ADMIN_SOCKET_AUTH',
            socketId: socket.id,
            wallet,
            userId: socket.userId,
          });
          console.log(`[Socket Auth] Admin authenticated: ${socket.id} (wallet: ${wallet})`);
        } else {
          auditLog({
            action: 'ADMIN_SOCKET_DENIED',
            reason: 'Wallet not whitelisted',
            socketId: socket.id,
            wallet,
          });
          console.warn(`[Socket Auth] Admin token but wallet not whitelisted: ${socket.id} (wallet: ${wallet})`);
        }
      }

      console.log(`[Socket Auth] User authenticated: ${socket.id} (userId: ${socket.userId}, isAdmin: ${socket.isAdmin})`);
    } catch (err) {
      // Invalid token - log the attempt
      auditLog({
        action: 'SOCKET_AUTH_FAILED',
        socketId: socket.id,
        error: err.message,
      });
      console.warn(`[Socket Auth] Invalid token attempt: ${socket.id} - ${err.message}`);
    }

    next();
  });

  io.on('connection', async (socket) => {
    console.log(`Socket connected: ${socket.id} (Admin: ${socket.isAdmin || false})`);

    // Send current game state on connection
    try {
      const currentState = await gameState.getGameState();
      socket.emit('game-state', currentState);
    } catch (err) {
      console.error('Error getting game state:', err);
    }

    // Join game room
    socket.on('join-game', ({ gameId }) => {
      socket.join(gameId || 'main');
      console.log(`Socket ${socket.id} joined game: ${gameId || 'main'}`);
    });

    // Leave game room
    socket.on('leave-game', ({ gameId }) => {
      socket.leave(gameId || 'main');
      console.log(`Socket ${socket.id} left game: ${gameId || 'main'}`);
    });

    // ============== ADMIN EVENTS ==============

    // Admin: Start game - SECURITY HARDENED
    socket.on('admin:start-game', async () => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'start-game',
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_STARTED',
          adminId: socket.userId,
          adminWallet: socket.wallet,
        });

        const state = await gameState.startGame();
        io.emit('game-started', state);

        // Emit full game state to ensure all clients have correct mode
        const fullState = await gameState.getGameState();
        io.emit('game-state', fullState);

        console.log('Game started by admin, status:', state.status, 'gameMode:', fullState.gameMode);
      } catch (err) {
        console.error('Error starting game:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Pause game - SECURITY HARDENED
    socket.on('admin:pause-game', async () => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'pause-game',
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_PAUSED',
          adminId: socket.userId,
        });

        const state = await gameState.pauseGame();
        io.emit('game-paused', state);
        io.emit('game-state', state);
        console.log('Game paused by admin');
      } catch (err) {
        console.error('Error pausing game:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Resume game - SECURITY HARDENED
    socket.on('admin:resume-game', async () => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'resume-game',
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_RESUMED',
          adminId: socket.userId,
        });

        const state = await gameState.resumeGame();
        io.emit('game-resumed', state);
        io.emit('game-state', state);
        console.log('Game resumed by admin');
      } catch (err) {
        console.error('Error resuming game:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: End game - SECURITY HARDENED
    socket.on('admin:end-game', async (data) => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'end-game',
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_ENDED',
          adminId: socket.userId,
          winner: data?.winner || null,
        });

        const state = await gameState.endGame(data?.winner);
        io.emit('game-ended', state);
        io.emit('game-state', state);
        console.log('Game ended by admin');
      } catch (err) {
        console.error('Error ending game:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Clear game (reset UI without starting new game)
    socket.on('admin:clear-game', async () => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'clear-game',
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_CLEARED',
          adminId: socket.userId,
          adminWallet: socket.wallet,
        });

        const state = await gameState.clearGame();
        io.emit('game-cleared', state);
        io.emit('game-state', state);
        console.log('Game cleared by admin');
      } catch (err) {
        console.error('Error clearing game:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Call number - SECURITY HARDENED
    socket.on('admin:call-number', async ({ number }) => {
      // SECURITY: Rate limit check
      if (!checkSocketRateLimit(socket.id, 'admin:call-number')) {
        auditLog({
          action: 'RATE_LIMIT_SOCKET',
          event: 'admin:call-number',
          socketId: socket.id,
        });
        socket.emit('error', { message: 'Too many requests. Please slow down.' });
        return;
      }

      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'call-number',
          number,
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      // SECURITY: Validate number is in valid bingo range (1-75)
      if (!Number.isInteger(number) || number < 1 || number > 75) {
        auditLog({
          action: 'INVALID_NUMBER_CALL',
          adminId: socket.userId,
          number,
        });
        socket.emit('error', { message: 'Invalid number. Must be between 1 and 75.' });
        return;
      }

      try {
        auditLog({
          action: 'NUMBER_CALLED',
          adminId: socket.userId,
          number,
        });

        const state = await gameState.callNumber(number);

        // Emit to all clients
        io.emit('number-called', {
          number,
          calledNumbers: state.calledNumbers,
        });
        io.emit('game-state', state);

        console.log(`Number called: ${number}`);

        // Check for winners
        await checkForWinners(io, state.calledNumbers);
      } catch (err) {
        console.error('Error calling number:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Uncall number (remove incorrectly called number) - SECURITY HARDENED
    socket.on('admin:uncall-number', async ({ number }) => {
      // SECURITY: Rate limit check
      if (!checkSocketRateLimit(socket.id, 'admin:uncall-number')) {
        auditLog({
          action: 'RATE_LIMIT_SOCKET',
          event: 'admin:uncall-number',
          socketId: socket.id,
        });
        socket.emit('error', { message: 'Too many requests. Please slow down.' });
        return;
      }

      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'uncall-number',
          number,
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      // SECURITY: Validate number is in valid bingo range (1-75)
      if (!Number.isInteger(number) || number < 1 || number > 75) {
        auditLog({
          action: 'INVALID_NUMBER_UNCALL',
          adminId: socket.userId,
          number,
        });
        socket.emit('error', { message: 'Invalid number. Must be between 1 and 75.' });
        return;
      }

      try {
        auditLog({
          action: 'NUMBER_UNCALLED',
          adminId: socket.userId,
          number,
        });

        const state = await gameState.uncallNumber(number);

        // Emit to all clients
        io.emit('number-uncalled', {
          number,
          calledNumbers: state.calledNumbers,
          currentNumber: state.currentNumber,
        });
        io.emit('game-state', state);

        console.log(`Number uncalled: ${number}`);
      } catch (err) {
        console.error('Error uncalling number:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Set game mode - SECURITY HARDENED
    socket.on('admin:set-game-mode', async ({ mode }) => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'GAME_ACTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          attemptedAction: 'set-game-mode',
          mode,
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        auditLog({
          action: 'GAME_MODE_CHANGED',
          adminId: socket.userId,
          adminWallet: socket.wallet,
          newMode: mode,
        });

        const result = await gameState.setGameMode(mode);
        const patternInfo = gameState.getPatternInfoForMode(mode);

        // Emit to all clients
        io.emit('game-mode-changed', {
          mode,
          patternInfo,
        });

        // Also update game state for all
        const state = await gameState.getGameState();
        io.emit('game-state', state);

        console.log(`Game mode changed to: ${mode} by admin`);
      } catch (err) {
        console.error('Error setting game mode:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Verify winner - SECURITY HARDENED
    socket.on('admin:verify-winner', async ({ cardId }) => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'WINNER_VERIFICATION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          cardId,
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        const purchasedCard = await gameState.getPurchasedCard(cardId);
        if (!purchasedCard) {
          auditLog({
            action: 'WINNER_VERIFICATION_FAILED',
            reason: 'Card not found',
            cardId,
            adminId: socket.userId,
          });
          socket.emit('error', { message: 'Card not found' });
          return;
        }

        // SECURITY: Verify card integrity if hash exists
        if (purchasedCard.card.hash) {
          const isValid = bingoCard.verifyCardIntegrity(purchasedCard.card);
          if (!isValid) {
            auditLog({
              action: 'CARD_INTEGRITY_FAILED',
              cardId,
              owner: purchasedCard.owner,
              adminId: socket.userId,
            });
            socket.emit('error', { message: 'Card integrity verification failed - possible tampering detected' });
            return;
          }
        }

        // CRITICAL: Get current game mode for correct validation
        const currentState = await gameState.getGameState();
        const gameMode = currentState.gameMode || 'fullCard';

        const calledNumbers = await gameState.getCalledNumbers();
        const result = bingoCard.checkWinner(purchasedCard.card, calledNumbers, gameMode);

        if (result.isWinner) {
          // Get pattern info for display name
          const patternInfo = bingoCard.getPatternInfo(gameMode);

          // Winner structure matching Game model schema
          const winner = {
            odId: purchasedCard.owner,
            odUsername: purchasedCard.ownerUsername,
            wallet: purchasedCard.ownerWallet,
            cardId,
            prizeAmount: '0', // TODO: Calculate from prize pool
            // Extra fields for emit (not saved to DB)
            pattern: result.pattern || result.modeName || gameMode,
            patternName: patternInfo?.name || result.modeName || gameMode,
            gameMode: gameMode,
            verifiedAt: new Date().toISOString(),
          };

          // SECURITY: Audit log for winner verification
          auditLog({
            action: 'WINNER_VERIFIED',
            cardId,
            owner: purchasedCard.owner,
            pattern: result.pattern,
            adminId: socket.userId,
            calledNumbersCount: calledNumbers.length,
          });

          const state = await gameState.endGame(winner);
          io.emit('winner-announced', { winner });
          io.emit('game-ended', state);
          io.emit('game-state', state);

          console.log('Winner verified:', winner);
        } else {
          auditLog({
            action: 'WINNER_VERIFICATION_FAILED',
            reason: 'Card not a winner',
            cardId,
            owner: purchasedCard.owner,
            adminId: socket.userId,
          });
          socket.emit('verification-result', {
            cardId,
            isWinner: false,
            message: 'Card is not a winner',
          });
        }
      } catch (err) {
        console.error('Error verifying winner:', err);
        auditLog({
          action: 'WINNER_VERIFICATION_ERROR',
          cardId,
          error: err.message,
          adminId: socket.userId,
        });
        socket.emit('error', { message: err.message });
      }
    });

    // Admin: Reject potential winner and resume game
    // CRITICAL: Also disables the card to prevent it from being detected as winner again
    socket.on('admin:reject-winner', async ({ cardId }) => {
      if (!socket.isAdmin) {
        auditLog({
          action: 'WINNER_REJECTION_DENIED',
          reason: 'Not admin',
          socketId: socket.id,
          cardId,
        });
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      try {
        // CRITICAL: Disable the card first - mark as 'won' so it's excluded from future checks
        // This prevents the same card from triggering winner detection again
        await gameState.disableWonCard(cardId);

        auditLog({
          action: 'WINNER_REJECTED',
          cardId,
          adminId: socket.userId,
          adminWallet: socket.wallet,
          cardDisabled: true,
        });

        // Resume the game
        const state = await gameState.resumeGame();

        // Notify all clients that the winner was rejected and game continues
        io.emit('winner-rejected', {
          cardId,
          disabled: true, // Inform clients the card is now disabled
          rejectedAt: new Date().toISOString(),
        });
        io.emit('game-resumed', state);
        io.emit('game-state', state);

        console.log(`[Admin] Potential winner ${cardId} rejected and disabled, game resumed`);
      } catch (err) {
        console.error('Error rejecting winner:', err);
        socket.emit('error', { message: err.message });
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}

/**
 * Check all purchased cards for potential winners
 * CRITICAL: Uses current game mode to validate winning pattern
 */
async function checkForWinners(io, calledNumbers) {
  try {
    // CRITICAL: Get current game mode for correct pattern validation
    const currentState = await gameState.getGameState();
    const gameMode = currentState.gameMode || 'fullCard';

    console.log(`[Winner Check] Checking ${calledNumbers.length} called numbers with mode: ${gameMode}`);

    const purchasedCards = await gameState.getAllPurchasedCards();

    for (const { card, owner, ownerUsername, ownerWallet } of purchasedCards) {
      // CRITICAL: Pass gameMode to checkWinner for correct pattern validation
      const result = bingoCard.checkWinner(card, calledNumbers, gameMode);

      if (result.isWinner) {
        console.log(`BINGO! Potential winner detected: ${ownerUsername || owner} with card ${card.id} (pattern: ${result.pattern || result.modeName}, mode: ${gameMode})`);

        // CRITICAL: Auto-pause the game when a potential winner is detected
        await gameState.pauseGame();
        io.emit('game-paused', { reason: 'potential-winner' });

        // Notify ALL clients about potential winner with card data for display
        io.emit('potential-winner', {
          cardId: card.id,
          cardNumbers: card.numbers, // Include card numbers for display
          owner: owner,
          username: ownerUsername,
          wallet: ownerWallet,
          pattern: result.pattern || result.modeName,
          gameMode: gameMode,
          detectedAt: new Date().toISOString(),
        });

        console.log(`[Game] Auto-paused due to potential winner`);
        // Only process first winner (avoid multiple pauses)
        break;
      }
    }
  } catch (err) {
    console.error('Error checking for winners:', err);
  }
}

export default { setupSocketHandlers };
