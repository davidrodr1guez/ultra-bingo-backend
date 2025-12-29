/**
 * Game state management with MongoDB persistence
 */

import mongoose from 'mongoose';
import { Card, Game, User, GAME_STATUS, GAME_MODES } from '../models/index.js';
import Winner from '../models/Winner.js';
import { generateMultipleCards, getPatternInfo, getAllPatterns, getPatternProgress, checkWinner } from './bingoCard.js';

// Re-export for backwards compatibility
export { GAME_STATUS, GAME_MODES };

// ============== GAME MANAGEMENT ==============

/**
 * Get current game state
 */
export async function getGameState() {
  const game = await Game.findCurrent();
  if (!game) {
    return {
      id: null,
      status: GAME_STATUS.WAITING,
      gameMode: GAME_MODES.FULL_CARD,
      calledNumbers: [],
      currentNumber: null,
      winner: null,
      startedAt: null,
      endedAt: null,
      canPurchase: true,
    };
  }
  return {
    id: game.gameId,
    status: game.status,
    gameMode: game.gameMode || GAME_MODES.FULL_CARD,
    calledNumbers: game.calledNumbers,
    currentNumber: game.currentNumber,
    winner: game.winner,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    canPurchase: game.canPurchaseCards(),
  };
}

/**
 * Check if card purchases are currently allowed
 */
export async function canPurchaseCards() {
  const game = await Game.findActive();
  if (!game) return true; // No active game, purchases allowed
  return game.canPurchaseCards();
}

/**
 * Set game mode (only when not playing)
 */
export async function setGameMode(mode) {
  let game = await Game.findActive();

  // If no active game, create one in waiting state
  if (!game) {
    const gameId = `game_${Date.now()}`;
    game = new Game({
      gameId,
      status: GAME_STATUS.WAITING,
      gameMode: mode,
    });
    await game.save();
    return getGameState();
  }

  await game.setGameMode(mode);
  return getGameState();
}

/**
 * Get pattern info for display
 */
export function getPatternInfoForMode(mode) {
  return getPatternInfo(mode);
}

/**
 * Get all available patterns
 */
export function getAvailablePatterns() {
  return getAllPatterns();
}

/**
 * Start a new game
 * CRITICAL: Preserves the gameMode from the previous/waiting game
 */
export async function startGame() {
  // Get current game mode from active/waiting game before ending it
  const activeGame = await Game.findActive();
  const currentGameMode = activeGame?.gameMode || GAME_MODES.FULL_CARD;

  // End any active game first
  if (activeGame) {
    await activeGame.end();
  }

  const gameId = `game_${Date.now()}`;
  const game = new Game({
    gameId,
    status: GAME_STATUS.PLAYING,
    gameMode: currentGameMode, // CRITICAL: Preserve the selected game mode
    startedAt: new Date(),
  });
  await game.save();

  return {
    id: game.gameId,
    status: game.status,
    gameMode: game.gameMode, // Include gameMode in response
    calledNumbers: game.calledNumbers,
    currentNumber: game.currentNumber,
    winner: game.winner,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
  };
}

/**
 * Pause the game
 */
export async function pauseGame() {
  const game = await Game.findActive();
  if (game && game.status === GAME_STATUS.PLAYING) {
    await game.pause();
  }
  return getGameState();
}

/**
 * Resume the game
 */
export async function resumeGame() {
  const game = await Game.findActive();
  if (game && game.status === GAME_STATUS.PAUSED) {
    await game.resume();
  }
  return getGameState();
}

/**
 * End the game and save winner to history if exists
 */
export async function endGame(winner = null) {
  const game = await Game.findActive();
  if (game) {
    // Save winner to history if exists
    if (winner && winner.cardId) {
      try {
        const totalCards = await Card.countDocuments({ status: 'purchased' });
        const winnerRecord = new Winner({
          winnerId: `winner_${Date.now()}_${winner.cardId.slice(-8)}`,
          gameId: game.gameId,
          odId: winner.odId || 'unknown',
          odUsername: winner.odUsername || 'Anónimo',
          wallet: winner.wallet?.toLowerCase() || '',
          cardId: winner.cardId,
          gameMode: winner.gameMode || game.gameMode || 'fullCard',
          patternName: winner.patternName || winner.pattern || game.gameMode || 'fullCard',
          prizeAmount: winner.prizeAmount || '0',
          prizeToken: 'USDC',
          totalCalledNumbers: game.calledNumbers.length,
          totalCards: totalCards,
          wonAt: new Date(),
        });
        await winnerRecord.save();
        console.log(`[GameState] Winner saved to history: ${winner.odUsername} (${winner.cardId})`);
      } catch (err) {
        console.error('[GameState] Error saving winner to history:', err);
        // Don't fail the game end if winner save fails
      }
    }
    await game.end(winner);

    // CRITICAL: Re-enable cards that were disabled during this game (rejected winners)
    // Cards with status 'won' should return to 'purchased' so they can play future games
    const reEnabledResult = await Card.updateMany(
      { status: 'won' },
      { $set: { status: 'purchased' } }
    );
    if (reEnabledResult.modifiedCount > 0) {
      console.log(`[GameState] Re-enabled ${reEnabledResult.modifiedCount} cards that were disabled during the game`);
    }
  }
  return getGameState();
}

/**
 * Clear game state (reset UI without starting new game)
 * Resets called numbers and winner but keeps game in 'waiting' status
 */
export async function clearGame() {
  const game = await Game.findActive();
  if (game) {
    game.calledNumbers = [];
    game.currentNumber = null;
    game.winner = null;
    game.status = 'waiting';
    await game.save();
    console.log('[GameState] Game cleared - ready for new game');
  } else {
    // Create a new game in waiting status if none exists
    const newGame = new Game({
      gameId: `game_${Date.now()}`,
      status: 'waiting',
      calledNumbers: [],
      currentNumber: null,
      winner: null,
      gameMode: 'fullCard',
    });
    await newGame.save();
    console.log('[GameState] New game created in waiting status');
  }

  // Re-enable any cards that were disabled during previous game
  const reEnabledResult = await Card.updateMany(
    { status: 'won' },
    { $set: { status: 'purchased' } }
  );
  if (reEnabledResult.modifiedCount > 0) {
    console.log(`[GameState] Re-enabled ${reEnabledResult.modifiedCount} cards`);
  }

  return getGameState();
}

/**
 * Get recent winners from history
 */
export async function getRecentWinners(limit = 10) {
  return Winner.getRecent(limit);
}

/**
 * Get winners by wallet
 */
export async function getWinnersByWallet(wallet, limit = 10) {
  return Winner.getByWallet(wallet, limit);
}

/**
 * Call a number
 */
export async function callNumber(number) {
  const game = await Game.findActive();
  if (!game) {
    throw new Error('No active game');
  }
  await game.callNumber(number);
  return getGameState();
}

/**
 * Get called numbers
 */
export async function getCalledNumbers() {
  const game = await Game.findCurrent();
  return game ? [...game.calledNumbers] : [];
}

// ============== CARDS MANAGEMENT ==============

/**
 * Add available cards
 */
export async function addAvailableCards(cards) {
  const cardDocs = cards.map(card => ({
    cardId: card.id,
    numbers: card.numbers,
    status: 'available',
    createdAt: new Date(),
  }));

  try {
    const result = await Card.insertMany(cardDocs, { ordered: false });
    console.log(`[GameState] Inserted ${result.length} cards into MongoDB`);
    return result.length;
  } catch (err) {
    // With ordered: false, some docs may have been inserted even if there were errors
    if (err.code === 11000) {
      // Duplicate key error - some cards may have been inserted
      const insertedCount = err.insertedDocs?.length || 0;
      console.log(`[GameState] Inserted ${insertedCount} cards (some duplicates ignored)`);
      return insertedCount;
    }
    throw err;
  }
}

/**
 * Get all available cards
 */
export async function getAvailableCards(limit = 50) {
  const cards = await Card.findAvailable(limit);
  return cards.map(c => ({
    id: c.cardId,
    numbers: c.numbers,
  }));
}

/**
 * Count available cards
 */
export async function countAvailableCards() {
  return Card.countDocuments({ status: 'available' });
}

/**
 * Remove cards from available (when purchased)
 */
export async function removeFromAvailable(cardIds) {
  await Card.updateMany(
    { cardId: { $in: cardIds } },
    { $set: { status: 'purchased' } }
  );
}

/**
 * Add purchased card
 */
export async function addPurchasedCard(card, owner, wallet = null, txHash = null, price = null) {
  await Card.findOneAndUpdate(
    { cardId: card.id },
    {
      $set: {
        status: 'purchased',
        owner,
        ownerWallet: wallet,
        purchaseTxHash: txHash,
        pricePaid: price,
        purchasedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/**
 * Get cards by owner
 */
export async function getCardsByOwner(ownerId) {
  const cards = await Card.findByOwner(ownerId);
  return cards.map(c => ({
    id: c.cardId,
    numbers: c.numbers,
    purchasedAt: c.purchasedAt,
    txHash: c.purchaseTxHash,
  }));
}

/**
 * Get all purchased cards
 */
export async function getAllPurchasedCards() {
  const cards = await Card.find({ status: 'purchased' });
  return cards.map(c => ({
    card: { id: c.cardId, numbers: c.numbers },
    owner: c.owner,
    ownerUsername: c.ownerUsername,
    ownerWallet: c.ownerWallet,
    purchasedAt: c.purchasedAt,
    txHash: c.purchaseTxHash,
  }));
}

/**
 * Get purchased card by ID
 */
export async function getPurchasedCard(cardId) {
  const card = await Card.findOne({ cardId, status: 'purchased' });
  if (!card) return null;
  return {
    card: { id: card.cardId, numbers: card.numbers },
    owner: card.owner,
    ownerUsername: card.ownerUsername,
    ownerWallet: card.ownerWallet,
    purchasedAt: card.purchasedAt,
    txHash: card.purchaseTxHash,
  };
}

/**
 * Check if card is available
 */
export async function isCardAvailable(cardId) {
  const card = await Card.findOne({ cardId, status: 'available' });
  return !!card;
}

/**
 * Purchase card atomically (single card)
 */
export async function purchaseCard(cardId, owner, wallet, txHash, price, username = null) {
  // Get username from user if not provided
  let ownerUsername = username;
  if (!ownerUsername && owner) {
    const user = await User.findByUserId(owner);
    ownerUsername = user?.username || null;
  }

  const card = await Card.findOneAndUpdate(
    { cardId, status: 'available' },
    {
      $set: {
        status: 'purchased',
        owner,
        ownerUsername,
        ownerWallet: wallet,
        purchaseTxHash: txHash,
        pricePaid: price,
        purchasedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!card) {
    throw new Error(`Card ${cardId} is not available`);
  }

  return {
    id: card.cardId,
    numbers: card.numbers,
    owner: card.owner,
    ownerUsername: card.ownerUsername,
    ownerWallet: card.ownerWallet,
  };
}

/**
 * Purchase multiple cards atomically using MongoDB transaction
 * Prevents race conditions where multiple users try to buy the same cards
 */
export async function purchaseCardsAtomic(cardIds, owner, wallet, txHash, pricePerCard, username = null) {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    // Get username from user if not provided
    let ownerUsername = username;
    if (!ownerUsername && owner) {
      const user = await User.findByUserId(owner);
      ownerUsername = user?.username || null;
    }

    const purchasedCards = [];
    const now = new Date();

    // Try to purchase each card atomically within the transaction
    for (const cardId of cardIds) {
      const card = await Card.findOneAndUpdate(
        { cardId, status: 'available' },
        {
          $set: {
            status: 'purchased',
            owner,
            ownerUsername,
            ownerWallet: wallet,
            purchaseTxHash: txHash,
            pricePaid: pricePerCard,
            purchasedAt: now,
          },
        },
        { new: true, session }
      );

      if (!card) {
        // Card not available - abort transaction
        throw new Error(`Card ${cardId} is not available`);
      }

      purchasedCards.push({
        id: card.cardId,
        numbers: card.numbers,
        owner: card.owner,
        ownerUsername: card.ownerUsername,
        ownerWallet: card.ownerWallet,
      });
    }

    await session.commitTransaction();
    return { success: true, cards: purchasedCards, errors: [] };

  } catch (error) {
    await session.abortTransaction();
    console.error('[GameState] Transaction aborted:', error.message);
    return { success: false, cards: [], errors: [{ error: error.message }] };

  } finally {
    session.endSession();
  }
}

// ============== USER MANAGEMENT ==============

/**
 * Create or update user
 */
export async function upsertUser(userId, userData) {
  const user = await User.findOneAndUpdate(
    { odId: userId },
    {
      $set: {
        ...userData,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      },
      $setOnInsert: {
        odId: userId,
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  return {
    id: user.odId,
    username: user.username,
    wallet: user.wallet,
    isAdmin: user.isAdmin || false,
    profileImage: user.profileImage,
    stats: user.stats,
  };
}

/**
 * Get user by ID
 */
export async function getUser(userId) {
  const user = await User.findByUserId(userId);
  if (!user) return null;
  return {
    id: user.odId,
    username: user.username,
    wallet: user.wallet,
    isAdmin: user.isAdmin || false,
    profileImage: user.profileImage,
    stats: user.stats,
  };
}

/**
 * Get user by wallet address
 */
export async function getUserByWallet(wallet) {
  const user = await User.findByWallet(wallet);
  if (!user) return null;
  return {
    id: user.odId,
    username: user.username,
    wallet: user.wallet,
    isAdmin: user.isAdmin || false,
    profileImage: user.profileImage,
    stats: user.stats,
  };
}

/**
 * Increment user stats
 */
export async function incrementUserStats(userId, field, amount = 1) {
  const user = await User.findByUserId(userId);
  if (user) {
    await user.incrementStats(field, amount);
  }
}

// ============== INITIALIZATION ==============

/**
 * Initialize with some available cards
 */
export async function initializeCards(cards) {
  await addAvailableCards(cards);
}

/**
 * Ensure minimum available cards
 */
export async function ensureAvailableCards(minimum = 20, generate = 50) {
  const count = await Card.countDocuments({ status: 'available' });
  console.log(`[GameState] Available cards count: ${count}, minimum required: ${minimum}`);

  if (count < minimum) {
    const newCards = generateMultipleCards(generate);
    console.log(`[GameState] Generating ${generate} new cards...`);
    await addAvailableCards(newCards);
  }

  // Return final count
  const finalCount = await Card.countDocuments({ status: 'available' });
  console.log(`[GameState] Final available cards: ${finalCount}`);
  return finalCount;
}

// ============== RESERVATION MANAGEMENT ==============

/**
 * SECURITY: Reserve cards for a user during payment processing
 * Prevents race conditions where multiple users try to buy the same cards
 */
export async function reserveCards(cardIds, userId, ttlMinutes = 5) {
  // First, clean up any expired reservations
  await Card.cleanExpiredReservations();

  // Try to reserve the requested cards
  const reservedCards = await Card.reserveCards(cardIds, userId, ttlMinutes);
  return reservedCards.map(c => ({
    id: c.cardId,
    numbers: c.numbers,
  }));
}

/**
 * SECURITY: Release reserved cards (on payment failure or cancellation)
 */
export async function releaseReservation(cardIds, userId) {
  await Card.releaseReservation(cardIds, userId);
}

/**
 * SECURITY: Confirm reservation after successful payment
 * Converts reserved cards to purchased status
 */
export async function confirmReservation(cardIds, userId, wallet, txHash, pricePerCard, username = null) {
  // Get username from user if not provided
  let ownerUsername = username;
  if (!ownerUsername && userId) {
    const user = await User.findByUserId(userId);
    ownerUsername = user?.username || null;
  }

  const confirmedCards = await Card.confirmReservation(cardIds, userId, wallet, txHash, pricePerCard, ownerUsername);
  return { success: confirmedCards.length > 0, cards: confirmedCards };
}

/**
 * SECURITY: Clean up expired reservations
 */
export async function cleanExpiredReservations() {
  return Card.cleanExpiredReservations();
}

/**
 * Disable a card that won but was rejected (absent winner)
 * This prevents the card from being detected as a winner again
 */
export async function disableWonCard(cardId) {
  const result = await Card.findOneAndUpdate(
    { cardId, status: 'purchased' },
    { $set: { status: 'won' } },
    { new: true }
  );

  if (result) {
    console.log(`[GameState] Card ${cardId} marked as 'won' (disabled from future winner checks)`);
  }

  return result;
}

/**
 * Reset all cards - delete purchased and won cards, keep or regenerate available cards
 * @param {boolean} keepAvailable - If true, keep available cards. If false, regenerate all.
 * @param {number} generateCount - Number of cards to generate if not keeping available
 */
export async function resetAllCards(keepAvailable = false, generateCount = 100) {
  // Delete purchased and won cards
  const deletedPurchased = await Card.deleteMany({ status: { $in: ['purchased', 'won', 'reserved'] } });
  console.log(`[GameState] Deleted ${deletedPurchased.deletedCount} purchased/won/reserved cards`);

  if (!keepAvailable) {
    // Delete all available cards too
    const deletedAvailable = await Card.deleteMany({ status: 'available' });
    console.log(`[GameState] Deleted ${deletedAvailable.deletedCount} available cards`);

    // Generate new cards
    if (generateCount > 0) {
      const newCards = generateMultipleCards(generateCount);
      await addAvailableCards(newCards);
      console.log(`[GameState] Generated ${generateCount} new cards`);
    }
  }

  const finalCount = await Card.countDocuments({ status: 'available' });
  return {
    deletedPurchased: deletedPurchased.deletedCount,
    availableCards: finalCount,
  };
}

/**
 * Full reset - reset game AND all cards AND winners history
 * This starts everything fresh
 */
export async function fullReset(generateCount = 100) {
  // End any active game
  const game = await Game.findActive();
  if (game) {
    await game.end();
  }

  // Create new game in waiting state
  const newGame = new Game({
    gameId: `game_${Date.now()}`,
    status: 'waiting',
    calledNumbers: [],
    currentNumber: null,
    winner: null,
    gameMode: 'fullCard',
  });
  await newGame.save();

  // Reset all cards
  const cardResult = await resetAllCards(false, generateCount);

  // Clear winners history
  const deletedWinners = await Winner.deleteMany({});
  console.log(`[GameState] Deleted ${deletedWinners.deletedCount} winners from history`);

  console.log('[GameState] Full reset complete');

  return {
    game: await getGameState(),
    cards: cardResult,
    deletedWinners: deletedWinners.deletedCount,
  };
}

export default {
  GAME_STATUS,
  GAME_MODES,
  getGameState,
  canPurchaseCards,
  setGameMode,
  getPatternInfoForMode,
  getAvailablePatterns,
  startGame,
  pauseGame,
  resumeGame,
  endGame,
  clearGame,
  callNumber,
  getCalledNumbers,
  addAvailableCards,
  getAvailableCards,
  countAvailableCards,
  removeFromAvailable,
  addPurchasedCard,
  getCardsByOwner,
  getAllPurchasedCards,
  getPurchasedCard,
  isCardAvailable,
  purchaseCard,
  purchaseCardsAtomic,
  reserveCards,
  releaseReservation,
  confirmReservation,
  cleanExpiredReservations,
  disableWonCard,
  resetAllCards,
  fullReset,
  upsertUser,
  getUser,
  getUserByWallet,
  incrementUserStats,
  initializeCards,
  ensureAvailableCards,
  getRecentWinners,
  getWinnersByWallet,
};
