// Shared between the Express CORS config (app.ts) and the Socket.IO CORS
// config (socket/socket.ts) so the two never drift — a mismatch here means
// the socket handshake silently stops carrying the jwt cookie, since
// `credentials: true` requires an explicit origin list on both sides.
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
];

export default ALLOWED_ORIGINS;
