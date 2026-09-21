// Catch-all Vercel function for the Express API.
// Vercel forwards /api/* requests here while preserving the request path,
// allowing Express to handle the existing /api/... routes.
import app from '../server.ts';

export default app;
