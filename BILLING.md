# AI Note Taker — Plan & Billing Workflow

## Current plans

- **Free:** 3 meetings/month, 30 transcription minutes/month, 20 Ask AI questions/month.
- **Pro:** unlimited meetings, transcription minutes, and Ask AI questions.

## Current purchase flow

The project intentionally uses an **admin-verified manual billing flow** until a payment provider is connected:

1. A Free user opens **Usage & Plan**.
2. They choose Monthly or Yearly Pro and submit an upgrade request.
3. The request is stored in `UpgradeRequest` and remains pending. No plan is changed at this point.
4. An admin opens **Admin → Plans & Billing → Upgrade requests** and verifies the payment outside the app.
5. The admin can approve the request and optionally store a payment/reference number.
6. Approval creates a `Payment` record, creates an active `Subscription` with the selected billing period, and updates the user's plan.
7. The user immediately sees the active Pro subscription and limits.
8. Cancelling an active subscription from the admin panel moves the user back to Free and preserves the historical subscription record.

## Server-side enforcement

Plan limits are enforced on the server, not only in the UI:

- `/api/meetings/complete` blocks new meetings when the monthly meeting or transcription-minute limit is reached.
- `/api/meetings/:id/chat` blocks Ask AI when the feature is unavailable or the monthly question limit is reached.
- Existing meeting finalization with the same external ID remains idempotent.

## Data models

- `Plan` — pricing, limits, and feature flags.
- `Subscription` — the user's actual dated subscription period and status.
- `UpgradeRequest` — the user's manual purchase request and admin review state.
- `Payment` — verified payment information recorded during approval.

## Later payment-provider integration

Stripe/PayPal can be added later without changing the user plan model: provider webhooks should call the same subscription activation/cancellation service. Frontend payment success should never be trusted as proof of payment.
