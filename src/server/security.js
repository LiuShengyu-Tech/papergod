import { resolve, sep } from 'path';

export function sanitizePath(input, root) {
  if (!input || typeof input !== 'string') return null;
  if (input.includes('\0')) return null;
  const resolved = resolve(root, input);
  if (!resolved.startsWith(root + sep) && resolved !== root) return null;
  return resolved;
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.removeHeader('X-Powered-By');
  next();
}
