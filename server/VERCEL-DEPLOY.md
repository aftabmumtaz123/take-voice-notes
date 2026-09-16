# AI Note Taker — Vercel deployment

This folder is prepared to run the Express backend on Vercel.

## Deploy

1. Upload/connect **this `server` folder** as the Vercel project root.
2. Vercel should use `server.js` as the Express entry point.
3. In Vercel → Project → Settings → Environment Variables, add the values from `.env.example`.
4. Set `MONGODB_URI` to a MongoDB Atlas connection string. Do not use `mongodb://127.0.0.1:27017/...` on Vercel.
5. Redeploy.
6. Test `/api/health`. The response includes `deploymentVersion`; it should be `2026-09-16-vercel-mongo-auth-fix-01` after this fixed build is live.

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


## If `/api/health` returns 503

A 503 means the deployed application cannot establish MongoDB connectivity. Check these in order:

1. Vercel → Project → Settings → Environment Variables → `MONGODB_URI` exists for **Production**.
2. `MONGODB_URI` must be the MongoDB Atlas URI, not `127.0.0.1` or `localhost`.
3. MongoDB Atlas → Network Access must allow the Vercel runtime to connect. For initial testing, Atlas may use `0.0.0.0/0`; apply tighter controls when you have a suitable production networking setup.
4. Redeploy after changing an environment variable.
5. Open `/api/health` again and inspect `mongoError`.

The application disables Mongoose query buffering, so database failures should now return a clear 503 instead of `users.findOne() buffering timed out after 10000ms`.

## Username index fix

The `username` field now owns the single unique index with `unique: true`. There is no second `userSchema.index({ username: 1 })` declaration. This removes the Mongoose duplicate schema-index warning.

Vercel entry point: api/index.js (Express app in server/app.js).
