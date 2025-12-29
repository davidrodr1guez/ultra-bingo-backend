// DynamoDB Client and Document Client
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

// Table names from environment
export const MAIN_TABLE = process.env.DYNAMODB_TABLE || 'ultra-bingo-main';
export const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || 'ultra-bingo-connections';

// =============================================================================
// User Operations
// =============================================================================

export async function getUserById(odId) {
  const result = await docClient.send(new GetCommand({
    TableName: MAIN_TABLE,
    Key: { PK: `USER#${odId}`, SK: `USER#${odId}` },
  }));
  return result.Item;
}

export async function getUserByWallet(wallet) {
  const result = await docClient.send(new QueryCommand({
    TableName: MAIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `WALLET#${wallet.toLowerCase()}` },
  }));
  return result.Items?.[0];
}

export async function createUser(user) {
  const now = new Date().toISOString();
  const item = {
    PK: `USER#${user.odId}`,
    SK: `USER#${user.odId}`,
    GSI1PK: `WALLET#${user.wallet.toLowerCase()}`,
    entityType: 'USER',
    odId: user.odId,
    username: user.username,
    wallet: user.wallet.toLowerCase(),
    isAdmin: user.isAdmin || false,
    stats: {
      gamesPlayed: 0,
      gamesWon: 0,
      cardsPurchased: 0,
      totalSpent: '0',
      totalWon: '0',
    },
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: MAIN_TABLE,
    Item: item,
  }));

  return item;
}

export async function updateUserStats(odId, statsUpdate) {
  const updateExpressions = [];
  const expressionValues = {};
  const expressionNames = {};

  for (const [key, value] of Object.entries(statsUpdate)) {
    updateExpressions.push(`#stats.#${key} = :${key}`);
    expressionValues[`:${key}`] = value;
    expressionNames[`#${key}`] = key;
  }
  expressionNames['#stats'] = 'stats';

  await docClient.send(new UpdateCommand({
    TableName: MAIN_TABLE,
    Key: { PK: `USER#${odId}`, SK: `USER#${odId}` },
    UpdateExpression: `SET ${updateExpressions.join(', ')}, updatedAt = :now`,
    ExpressionAttributeValues: { ...expressionValues, ':now': new Date().toISOString() },
    ExpressionAttributeNames: expressionNames,
  }));
}

export async function getAllUsers(limit = 500) {
  const result = await docClient.send(new ScanCommand({
    TableName: MAIN_TABLE,
    FilterExpression: 'entityType = :type',
    ExpressionAttributeValues: { ':type': 'USER' },
    Limit: limit,
  }));
  return result.Items || [];
}

// =============================================================================
// Card Operations
// =============================================================================

export async function getAvailableCards(limit = 50) {
  const result = await docClient.send(new QueryCommand({
    TableName: MAIN_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'AVAILABLE' },
    Limit: limit,
  }));
  return result.Items || [];
}

export async function getCardById(cardId) {
  // First try available
  let result = await docClient.send(new GetCommand({
    TableName: MAIN_TABLE,
    Key: { PK: 'AVAILABLE', SK: `CARD#${cardId}` },
  }));

  if (result.Item) return result.Item;

  // Try to find in purchased cards (need to scan or use GSI)
  result = await docClient.send(new QueryCommand({
    TableName: MAIN_TABLE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `CARD#${cardId}` },
  }));

  return result.Items?.[0];
}

export async function getCardsByOwner(odId) {
  const result = await docClient.send(new QueryCommand({
    TableName: MAIN_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `USERCARD#${odId}` },
  }));
  return result.Items || [];
}

export async function getAllPurchasedCards(limit = 1000) {
  const result = await docClient.send(new ScanCommand({
    TableName: MAIN_TABLE,
    FilterExpression: 'entityType = :type AND #status = :status',
    ExpressionAttributeValues: { ':type': 'CARD', ':status': 'purchased' },
    ExpressionAttributeNames: { '#status': 'status' },
    Limit: limit,
  }));
  return result.Items || [];
}

export async function createCard(card) {
  const now = new Date().toISOString();
  const item = {
    PK: 'AVAILABLE',
    SK: `CARD#${card.cardId}`,
    GSI2PK: `CARD#${card.cardId}`,
    entityType: 'CARD',
    cardId: card.cardId,
    numbers: card.numbers,
    status: 'available',
    createdAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: MAIN_TABLE,
    Item: item,
  }));

  return item;
}

export async function reserveCards(cardIds, userId, ttlMinutes = 5) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const reservedCards = [];

  for (const cardId of cardIds) {
    try {
      // Get the card first
      const card = await docClient.send(new GetCommand({
        TableName: MAIN_TABLE,
        Key: { PK: 'AVAILABLE', SK: `CARD#${cardId}` },
      }));

      if (!card.Item || card.Item.status !== 'available') continue;

      // Update to reserved
      const updatedCard = {
        ...card.Item,
        status: 'reserved',
        reservedBy: userId,
        reservedAt: now.toISOString(),
        reservationExpiresAt: expiresAt.toISOString(),
        ttl: Math.floor(expiresAt.getTime() / 1000),
      };

      await docClient.send(new PutCommand({
        TableName: MAIN_TABLE,
        Item: updatedCard,
        ConditionExpression: '#status = :available',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':available': 'available' },
      }));

      reservedCards.push(updatedCard);
    } catch (e) {
      // Skip if condition failed (already reserved)
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    }
  }

  return reservedCards;
}

export async function confirmReservation(cardIds, userId, wallet, txHash, pricePerCard, username) {
  const now = new Date().toISOString();
  const confirmedCards = [];

  for (const cardId of cardIds) {
    try {
      // Get the reserved card
      const card = await docClient.send(new GetCommand({
        TableName: MAIN_TABLE,
        Key: { PK: 'AVAILABLE', SK: `CARD#${cardId}` },
      }));

      if (!card.Item || card.Item.status !== 'reserved' || card.Item.reservedBy !== userId) {
        continue;
      }

      // Delete from AVAILABLE partition
      await docClient.send(new DeleteCommand({
        TableName: MAIN_TABLE,
        Key: { PK: 'AVAILABLE', SK: `CARD#${cardId}` },
      }));

      // Create in USERCARD partition (purchased)
      const purchasedCard = {
        PK: `USERCARD#${userId}`,
        SK: `CARD#${cardId}`,
        GSI2PK: `CARD#${cardId}`,
        entityType: 'CARD',
        cardId: card.Item.cardId,
        numbers: card.Item.numbers,
        status: 'purchased',
        owner: userId,
        ownerUsername: username,
        ownerWallet: wallet,
        purchaseTxHash: txHash,
        pricePaid: pricePerCard,
        purchasedAt: now,
        createdAt: card.Item.createdAt,
      };

      await docClient.send(new PutCommand({
        TableName: MAIN_TABLE,
        Item: purchasedCard,
      }));

      confirmedCards.push({
        id: purchasedCard.cardId,
        numbers: purchasedCard.numbers,
        owner: purchasedCard.owner,
        ownerUsername: purchasedCard.ownerUsername,
        ownerWallet: purchasedCard.ownerWallet,
      });
    } catch (e) {
      console.error(`Failed to confirm card ${cardId}:`, e);
    }
  }

  return confirmedCards;
}

export async function releaseReservation(cardIds, userId) {
  for (const cardId of cardIds) {
    try {
      await docClient.send(new UpdateCommand({
        TableName: MAIN_TABLE,
        Key: { PK: 'AVAILABLE', SK: `CARD#${cardId}` },
        UpdateExpression: 'SET #status = :available, reservedBy = :null, reservedAt = :null, reservationExpiresAt = :null REMOVE #ttl',
        ConditionExpression: 'reservedBy = :userId',
        ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':available': 'available', ':null': null, ':userId': userId },
      }));
    } catch (e) {
      // Ignore if condition failed
    }
  }
}

// =============================================================================
// Game Operations
// =============================================================================

export async function getCurrentGame() {
  const result = await docClient.send(new GetCommand({
    TableName: MAIN_TABLE,
    Key: { PK: 'GAME', SK: 'CURRENT' },
  }));
  return result.Item;
}

export async function createGame(gameData) {
  const now = new Date().toISOString();
  const item = {
    PK: 'GAME',
    SK: 'CURRENT',
    entityType: 'GAME',
    gameId: gameData.gameId || `game_${Date.now()}`,
    status: 'waiting',
    gameMode: gameData.gameMode || 'fullCard',
    calledNumbers: [],
    currentNumber: null,
    winner: null,
    prizePool: '0',
    cardsSold: 0,
    startedAt: null,
    endedAt: null,
    createdAt: now,
  };

  await docClient.send(new PutCommand({
    TableName: MAIN_TABLE,
    Item: item,
  }));

  return item;
}

export async function updateGame(updates) {
  const updateExpressions = [];
  const expressionValues = {};
  const expressionNames = {};

  for (const [key, value] of Object.entries(updates)) {
    if (key === 'PK' || key === 'SK') continue;
    updateExpressions.push(`#${key} = :${key}`);
    expressionValues[`:${key}`] = value;
    expressionNames[`#${key}`] = key;
  }

  await docClient.send(new UpdateCommand({
    TableName: MAIN_TABLE,
    Key: { PK: 'GAME', SK: 'CURRENT' },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames,
  }));
}

// =============================================================================
// Connection Operations (WebSocket)
// =============================================================================

export async function saveConnection(connectionId, data = {}) {
  const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

  await docClient.send(new PutCommand({
    TableName: CONNECTIONS_TABLE,
    Item: {
      connectionId,
      ...data,
      connectedAt: new Date().toISOString(),
      ttl,
    },
  }));
}

export async function deleteConnection(connectionId) {
  await docClient.send(new DeleteCommand({
    TableName: CONNECTIONS_TABLE,
    Key: { connectionId },
  }));
}

export async function getAllConnections() {
  const result = await docClient.send(new ScanCommand({
    TableName: CONNECTIONS_TABLE,
  }));
  return result.Items || [];
}

export async function getConnectionsByUser(odId) {
  const result = await docClient.send(new QueryCommand({
    TableName: CONNECTIONS_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'odId = :odId',
    ExpressionAttributeValues: { ':odId': odId },
  }));
  return result.Items || [];
}
