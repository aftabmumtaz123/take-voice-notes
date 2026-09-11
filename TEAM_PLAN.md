# Team Plan

Team is a workspace-based plan with manual admin approval.

## Flow

1. User requests Team from **Manage subscription** and provides workspace name, seat count, billing cycle, and optional reason.
2. Admin reviews the request. Approval creates/activates the Team subscription and a workspace with the requested seat limit.
3. The requester becomes the workspace owner.
4. Owners/admins can invite teammates by email. Invitations expire after 7 days and use a hashed token.
5. Invited users accept the invitation and become workspace members. Members receive Team feature access through the workspace subscription; their personal plan is not changed.
6. Meetings are private by default. A Team user can explicitly **Share with Team**; shared meetings can be opened and used with Ask AI by workspace members.
7. Owner/admin can remove members. The owner cannot be removed.
8. If a Team subscription expires, its workspace is archived rather than deleted and data is preserved.

## Roles

- **Owner:** billing, plan changes, cancellation, members, shared meetings.
- **Admin:** member management and workspace collaboration.
- **Member:** use Team features and access shared meetings.

## Billing

Team uses the existing manual verification flow. The application does not claim automated payment processing.
