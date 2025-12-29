// WebSocket Connect Handler
import * as db from './lib/dynamodb.js';
import { verifyToken } from './lib/auth.js';

export async function handler(event) {
  console.log('WebSocket Connect:', JSON.stringify(event));

  const connectionId = event.requestContext.connectionId;
  const queryParams = event.queryStringParameters || {};

  try {
    let userData = {};

    // Try to authenticate if token provided
    if (queryParams.token) {
      const user = await verifyToken(queryParams.token);
      if (user) {
        userData = {
          odId: user.odId,
          username: user.username,
          wallet: user.wallet,
          isAdmin: user.isAdmin,
        };
      }
    }

    // Save connection
    await db.saveConnection(connectionId, userData);

    console.log(`Connection ${connectionId} saved for user:`, userData.odId || 'anonymous');

    return {
      statusCode: 200,
      body: 'Connected',
    };
  } catch (error) {
    console.error('Connect error:', error);
    return {
      statusCode: 500,
      body: 'Failed to connect',
    };
  }
}
