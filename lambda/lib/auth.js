// JWT Authentication helpers
import jwt from 'jsonwebtoken';
import { getSecrets, isAdminWallet } from './secrets.js';

export async function generateToken(user) {
  const secrets = await getSecrets();

  const payload = {
    odId: user.odId,
    username: user.username,
    wallet: user.wallet,
    isAdmin: user.isAdmin,
  };

  return jwt.sign(payload, secrets.JWT_SECRET, { expiresIn: '7d' });
}

export async function verifyToken(token) {
  const secrets = await getSecrets();

  try {
    return jwt.verify(token, secrets.JWT_SECRET);
  } catch (error) {
    return null;
  }
}

export async function authenticateRequest(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  return verifyToken(token);
}

export async function requireAuth(event) {
  const user = await authenticateRequest(event);

  if (!user) {
    throw { statusCode: 401, message: 'Unauthorized' };
  }

  return user;
}

export async function requireAdmin(event) {
  const user = await requireAuth(event);
  const secrets = await getSecrets();

  if (!user.isAdmin && !isAdminWallet(user.wallet, secrets.ADMIN_WALLETS)) {
    throw { statusCode: 403, message: 'Admin access required' };
  }

  return user;
}
