// Secrets Manager helper
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

let cachedSecrets = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getSecrets() {
  const now = Date.now();

  if (cachedSecrets && now < cacheExpiry) {
    return cachedSecrets;
  }

  const secretArn = process.env.SECRETS_ARN;
  if (!secretArn) {
    // Fallback to environment variables
    return {
      JWT_SECRET: process.env.JWT_SECRET || 'dev-secret',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin',
      ADMIN_WALLETS: process.env.ADMIN_WALLETS || '',
      X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL || 'https://facilitator.ultravioletadao.xyz',
      X402_NETWORK: process.env.X402_NETWORK || 'avalanche',
      X402_RECEIVER_ADDRESS: process.env.X402_RECEIVER_ADDRESS || '',
      CARD_PRICE: process.env.CARD_PRICE || '0.01',
    };
  }

  try {
    const response = await client.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));

    cachedSecrets = JSON.parse(response.SecretString);
    cacheExpiry = now + CACHE_TTL;

    return cachedSecrets;
  } catch (error) {
    console.error('Failed to get secrets:', error);
    throw error;
  }
}

export function isAdminWallet(wallet, adminWallets) {
  if (!wallet || !adminWallets) return false;
  const walletLower = wallet.toLowerCase();
  const admins = adminWallets.split(',').map(w => w.trim().toLowerCase());
  return admins.includes(walletLower);
}
