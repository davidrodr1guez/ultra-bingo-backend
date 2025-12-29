// WebSocket Message Handler
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import * as db from './lib/dynamodb.js';
import { verifyToken } from './lib/auth.js';

let apiClient = null;

function getApiClient(event) {
  if (!apiClient) {
    const endpoint = process.env.WEBSOCKET_API_ENDPOINT ||
      `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

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
    if (error.statusCode === 410) {
      // Connection is stale, delete it
      await db.deleteConnection(connectionId);
    }
    return false;
  }
}

async function broadcast(client, data, excludeConnectionId = null) {
  const connections = await db.getAllConnections();

  const promises = connections
    .filter(c => c.connectionId !== excludeConnectionId)
    .map(c => sendToConnection(client, c.connectionId, data));

  await Promise.all(promises);
}

export async function handler(event) {
  console.log('WebSocket Message:', JSON.stringify(event));

  const connectionId = event.requestContext.connectionId;
  const client = getApiClient(event);

  try {
    const message = JSON.parse(event.body);
    const { type, payload } = message;

    switch (type) {
      case 'ping':
        await sendToConnection(client, connectionId, { type: 'pong' });
        break;

      case 'authenticate':
        // Handle authentication
        if (payload?.token) {
          const user = await verifyToken(payload.token);
          if (user) {
            await db.saveConnection(connectionId, {
              odId: user.odId,
              username: user.username,
              wallet: user.wallet,
              isAdmin: user.isAdmin,
            });
            await sendToConnection(client, connectionId, {
              type: 'authenticated',
              payload: { odId: user.odId, username: user.username },
            });
          } else {
            await sendToConnection(client, connectionId, {
              type: 'error',
              payload: { message: 'Invalid token' },
            });
          }
        }
        break;

      case 'getGameState':
        const game = await db.getCurrentGame();
        await sendToConnection(client, connectionId, {
          type: 'gameState',
          payload: game,
        });
        break;

      case 'claimBingo':
        // Handle bingo claim - broadcast to admin
        const connections = await db.getAllConnections();
        const adminConnections = connections.filter(c => c.isAdmin);

        for (const admin of adminConnections) {
          await sendToConnection(client, admin.connectionId, {
            type: 'bingoClaim',
            payload: payload,
          });
        }

        await sendToConnection(client, connectionId, {
          type: 'bingoClaimReceived',
          payload: { message: 'Claim submitted for verification' },
        });
        break;

      default:
        await sendToConnection(client, connectionId, {
          type: 'error',
          payload: { message: 'Unknown message type' },
        });
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('Message handler error:', error);
    return { statusCode: 500, body: 'Error' };
  }
}
