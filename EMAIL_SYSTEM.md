# Email & Gmail system

The application now has persistent email templates, Gmail SMTP delivery, signup OTP verification, password reset, billing notifications, login alerts, and meeting lifecycle emails.

## Gmail setup
Use a Gmail or Google Workspace mailbox with 2-Step Verification enabled and a Google App Password. Add these to `server/.env` (never commit the real values):

```
GMAIL_SMTP_USER=yourgmail@gmail.com
GMAIL_SMTP_APP_PASSWORD=xxxx xxxx xxxx xxxx
GMAIL_SMTP_HOST=smtp.gmail.com
GMAIL_SMTP_PORT=465
GMAIL_SMTP_SECURE=true
GMAIL_FROM_NAME=AI Note Taker
APP_BASE_URL=http://localhost:4000
```

The app uses Gmail SMTP over TLS on port 465. It does not store the Gmail password in MongoDB or in email templates.

## Admin template center
Open **Admin → Email Templates**. Default templates are seeded into MongoDB on startup. Each template can be edited, enabled/disabled, or tested. The editor has a live preview that updates while typing.

## Included templates
- Email verification OTP
- Password reset
- Login notification
- Welcome after verification
- Upgrade request received
- Upgrade approved
- Upgrade request rejected
- Meeting saved
- Meeting summary ready
- Meeting processing issue
- Action items reminder

## Authentication flow
New password-based registrations require email verification before a session is created. OTPs expire after 10 minutes and allow up to five attempts. Forgot-password links expire after 30 minutes and invalidate existing sessions after a successful reset. Google sign-in accounts are treated as email verified by Google.
