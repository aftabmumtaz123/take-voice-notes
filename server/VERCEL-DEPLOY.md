# AI Note Taker — Vercel deployment

This folder is prepared to run the Express backend on Vercel.

## Deploy

1. Upload/connect **this `server` folder** as the Vercel project root.
2. Vercel should use `server.js` as the Express entry point.
3. In Vercel → Project → Settings → Environment Variables, add the values from `.env.example`.
4. Set `MONGODB_URI` to a MongoDB Atlas connection string. Do not use `mongodb://127.0.0.1:27017/...` on Vercel.
5. Redeploy.
6. Test `/api/health`.

## Required production variables

At minimum, configure:

- `MONGODB_URI`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional; the code has fallbacks)
- `APP_BASE_URL` (your Vercel HTTPS URL)
- Google OAuth variables if Google login is enabled
- Gmail SMTP variables if email is enabled
- Cloudinary variables if avatar uploads are enabled

## MongoDB Atlas

Allow the Vercel runtime to reach MongoDB Atlas. For initial testing, MongoDB Atlas can be configured to allow access from anywhere (`0.0.0.0/0`), but use appropriate production network/security controls for a real deployment.

## Important

Do not upload `.env` or real API keys to GitHub or the Vercel source. This deployment package intentionally excludes the original `.env` file.


## Important
Do not add a `builds` entry using `@vercel/node` for this project. Vercel now detects the Express app from `server.js` and its package dependencies. The app exports `default app`.

### MongoDB/Vercel connection fix

The server now initializes MongoDB **before database-backed Express routes are executed**. This is important because Express middleware only applies to routes registered after the middleware. The previous connection middleware was located after routes such as `/verify-email`, which could allow a Mongoose query to run before the Vercel function had connected and produce `users.findOne() buffering timed out after 10000ms`.

The connection helper also reuses an in-flight connection attempt and reconnects when a warm Vercel instance has lost its MongoDB connection.
