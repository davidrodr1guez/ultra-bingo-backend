// WebSocket Disconnect Handler
import * as db from './lib/dynamodb.js';

export async function handler(event) {
  console.log('WebSocket Disconnect:', JSON.stringify(event));

  const connectionId = event.requestContext.connectionId;

  try {
    await db.deleteConnection(connectionId);
    console.log(`Connection ${connectionId} deleted`);

    return {
      statusCode: 200,
      body: 'Disconnected',
    };
  } catch (error) {
    console.error('Disconnect error:', error);
    return {
      statusCode: 500,
      body: 'Failed to disconnect',
    };
  }
}
