// Vercel serverless entry point.
// The main Express application lives in server.ts; this file makes the
// /api/* routes explicit to Vercel instead of relying on framework detection.
import app from '../server.ts';

export default app;
