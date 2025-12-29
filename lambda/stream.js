// DynamoDB Stream Processor - Broadcasts real-time updates
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import * as db from './lib/dynamodb.js';

let apiClient = null;

function getApiClient() {
  if (!apiClient) {
    const endpoint = process.env.WEBSOCKET_API_ENDPOINT;
    if (!endpoint) {
      throw new Error('WEBSOCKET_API_ENDPOINT not configured');
    }
    apiClient = new ApiGatewayManagementApiClient({
      endpoint: endpoint.replace('wss://', 'https://'),
    });
  }
  return apiClient;
}

async function sendToConnection(client, connectionId, data) {
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (error.statusCode === 410 || error.$metadata?.httpStatusCode === 410) {
      // Connection is stale, delete it
      await db.deleteConnection(connectionId);
    } else {
      console.error(`Failed to send to ${connectionId}:`, error);
    }
    return false;
  }
}

async function broadcast(client, data) {
  const connections = await db.getAllConnections();
  console.log(`Broadcasting to ${connections.length} connections:`, data.type);

  const results = await Promise.all(
    connections.map(c => sendToConnection(client, c.connectionId, data))
  );

  const successCount = results.filter(r => r).length;
  console.log(`Broadcast complete: ${successCount}/${connections.length} successful`);
}

export async function handler(event) {
  console.log('Stream event:', JSON.stringify(event));

  const client = getApiClient();

  for (const record of event.Records) {
    try {
      if (record.eventName === 'INSERT' || record.eventName === 'MODIFY') {
        const newImage = record.dynamodb.NewImage;
        const entityType = newImage?.entityType?.S;

        if (entityType === 'GAME') {
          // Game state changed - broadcast to all
          const gameData = unmarshallItem(newImage);

          await broadcast(client, {
            type: 'gameUpdate',
            payload: {
              gameId: gameData.gameId,
              status: gameData.status,
              gameMode: gameData.gameMode,
              calledNumbers: gameData.calledNumbers,
              currentNumber: gameData.currentNumber,
              cardsSold: gameData.cardsSold,
              prizePool: gameData.prizePool,
              winner: gameData.winner,
            },
          });

          // If a number was called, send specific event
          if (gameData.currentNumber) {
            await broadcast(client, {
              type: 'numberCalled',
              payload: {
                number: gameData.currentNumber,
                calledNumbers: gameData.calledNumbers,
              },
            });
          }

          // If game ended with winner
          if (gameData.status === 'ended' && gameData.winner) {
            await broadcast(client, {
              type: 'gameEnded',
              payload: {
                winner: gameData.winner,
                prizePool: gameData.prizePool,
              },
            });
          }
        }

        if (entityType === 'CARD' && newImage?.status?.S === 'purchased') {
          // Card purchased - broadcast update
          const cardData = unmarshallItem(newImage);

          await broadcast(client, {
            type: 'cardPurchased',
            payload: {
              cardId: cardData.cardId,
              owner: cardData.owner,
              ownerUsername: cardData.ownerUsername,
            },
          });
        }
      }
    } catch (error) {
      console.error('Error processing record:', error);
    }
  }

  return { statusCode: 200 };
}

// Simple unmarshall helper
function unmarshallItem(item) {
  const result = {};

  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined) result[key] = value.S;
    else if (value.N !== undefined) result[key] = Number(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.NULL !== undefined) result[key] = null;
    else if (value.L !== undefined) result[key] = value.L.map(v => {
      if (v.S) return v.S;
      if (v.N) return Number(v.N);
      return v;
    });
    else if (value.M !== undefined) result[key] = unmarshallItem(value.M);
    else result[key] = value;
  }

  return result;
}
