# Email App Backend README

## Project Overview
This backend powers the Simulated Email Service Application for the "Cross-Platform Mobile Application Development - 502071" course, Semester 1, Academic Year 2024-2025. Built with **Node.js**, **Express.js**, and **MongoDB Atlas**, it leverages **Cloudinary** for file storage and **Socket.IO** for real-time notifications. The backend supports user authentication, email management, label management, auto-reply functionality, and AI-powered spam detection, with email as the primary identifier for sending, receiving, CC, and BCC operations.

## Prerequisites
To run the backend, ensure the following are installed:
- **Node.js**: Version 16.x or higher
- **MongoDB Atlas**: A cloud MongoDB instance (or local MongoDB server)
- **Cloudinary Account**: For storing profile pictures and email attachments
- **Gmail Account**: For sending OTP emails during authentication
- **Git**: For cloning the repository
- **NPM**: For installing dependencies

## Installation
1. **Clone the Repository**:
   ```
   git clone <repository-url>
   cd email-app-backend
   ```

2. **Install Dependencies**:
   ```
   npm install
   ```

3. **Set Up Environment Variables**:
   Create a `.env` file in the project root with the following:
   ```
   MONGODB_URI=<your-mongodb-atlas-connection-string>
   JWT_SECRET=<your-jwt-secret>
   CLOUDINARY_CLOUD_NAME=<your-cloudinary-cloud-name>
   CLOUDINARY_API_KEY=<your-cloudinary-api-key>
   CLOUDINARY_API_SECRET=<your-cloudinary-api-secret>
   GMAIL_USER=<your-gmail-address>
   GMAIL_PASS=<your-gmail-app-password>
   PORT=3000
   ```
   - Replace placeholders with actual values.
   - Use a **Gmail App Password** for `GMAIL_PASS` (not the regular password).

4. **Run the Server**:
   - Development mode (with auto-restart):
     ```
     npm run dev
     ```
   - Production mode:
     ```
     npm start
     ```
   The server runs on `http://localhost:3000` (or the port specified in `.env`).

## Backend Functionality
The backend implements the following features as per the project rubric:

### 1. Account Management (1.5 points)
- **Registration** (`/api/auth/register`): Users register with a phone number and strong password (hashed with bcrypt). A JWT token is issued.
- **Login** (`/api/auth/login`): Supports phone number and password login, with optional 2FA via OTP sent to the user's verified email.
- **Password Management**:
  - **Change Password** (`/api/user/change-password`): Requires old password verification.
  - **Password Recovery** (`/api/auth/forgot-password`, `/api/auth/reset-password`): Sends OTP to verified email for password reset.
- **Two-Step Verification** (`/api/user/toggle-2fa`): Enables/disables 2FA, requiring a verified email.
- **Profile Management**:
  - **View Profile** (`/api/user/profile`): Returns phone, email, name, picture, 2FA status, and email verification status.
  - **Update Profile** (`/api/user/update-profile`): Updates email, name, and profile picture (stored on Cloudinary). Email updates mark `isEmailVerified: true`.
- **Token Verification** (`/api/auth/verify-token`): Validates JWT tokens and returns the user's email for WebSocket integration.

*Note*: Email verification is enforced for email-related actions (sending, receiving, CC, BCC).

### 2. Compose and Send Email (2.5 points)
- **Send Email** (`/api/email/send`): Sends emails with To, CC, and BCC fields (using verified emails as identifiers). Attachments (up to 5, 10MB each) are stored on Cloudinary. Emails are saved in the sender's "sent" folder and recipients'/CC/BCC's "inbox" or "spam" folders based on AI spam detection.
- **Auto-Save Drafts** (`/api/email/save-draft`): Saves drafts with optional attachments, returning the draft's ID.
- **Reply** (`/api/email/reply/:emailId`): Sends a reply with the original message included, with spam detection applied.
- **Forward** (`/api/email/forward/:emailId`): Forwards emails with original attachments to new recipients, with spam detection applied.
- **Email Actions**:
  - Mark read/unread (`/api/email/mark-read/:emailId`).
  - Star/unstar (`/api/email/star/:emailId`).
  - Move to trash (`/api/email/move-to-trash/:emailId`).
  - Delete permanently (`/api/email/:emailId`).
- **Attachment Support**: Accepts .jpg, .jpeg, .png, and .pdf files.

*Frontend Responsibility*: Implement a WYSIWYG editor (e.g., `flutter_quill`) for rich text formatting. The backend stores the HTML content.

### 3. View Emails (1.0 point)
- **List Emails** (`/api/email/list/:folder`): Retrieves emails from folders (inbox, sent, draft, starred, trash, spam) with basic (sender, recipients, subject, sentAt, isRead, isStarred, isSpam) or detailed views.
- **Folders**: Supports inbox, sent, draft, starred, trash, and spam.

*Frontend Responsibility*: Render basic and detailed email views, including previews, attachment display, and a dedicated spam folder.

### 4. Search Functionality (1.0 point)
- **Basic Search** (`/api/email/search`): Searches emails by keyword in subject or body.
- **Advanced Search** (`/api/email/search`): Filters by sender, recipient, attachments, and date range.

*Frontend Responsibility*: Provide a search interface for keyword input and advanced filters.

### 5. Label Management (0.75 point)
- **Create Label** (`/api/email/labels`): Creates a user-specific label.
- **Delete Label** (`/api/email/labels/:labelId`): Deletes a non-system label and removes it from emails.
- **Rename Label** (`/api/email/labels/:labelId`): Updates a non-system label's name.
- **Assign/Remove Label** (`/api/email/emails/:emailId/labels`): Adds/removes labels from emails.
- **List Labels** (`/api/email/labels`): Retrieves user labels, including the system-generated "Spam" label.
- **Filter by Label** (`/api/email/list/:folder?labelId=<id>`): Lists emails with a specific label.

*Frontend Responsibility*: Implement label management UI and filtering display, including handling the "Spam" label.

### 6. Notifications (0.5 point)
- **Real-Time Notifications**: Uses **Socket.IO** to send `newEmail` events to recipients, CC, and BCC when an email is received. Includes sender, subject, sent time, and spam status.
- **Implementation**: Users join a WebSocket room based on their verified email.

*Frontend Responsibility*: Integrate `socket.io-client` to listen for `newEmail` events and display notifications (e.g., badge, toast), indicating if the email is spam.

### 7. Auto Answer Mode (0.25 point)
- **Configure Auto Reply** (`/api/email/auto-reply`): Enables/disables auto-reply and sets a custom message.
- **Functionality**: Sends auto-replies to incoming non-spam emails if enabled and the recipient's email is verified.

*Frontend Responsibility*: Provide a settings UI for auto-reply configuration.

### 8. Spam Detection (Bonus Feature)
- **AI-Powered Spam Detection**: Automatically detects spam emails using a rule-based algorithm that checks for suspicious keywords, excessive links, unverified senders, too many recipients, and suspicious attachments. Emails flagged as spam are moved to the "spam" folder, marked with `isSpam: true`, and tagged with a system-generated "Spam" label.
- **Implementation**: Integrated into the `/api/email/send`, `/api/email/reply`, and `/api/email/forward` endpoints. The "Spam" label is automatically created for each user.
- **Folder Support**: A dedicated "spam" folder is available via `/api/email/list/spam`.

*Frontend Responsibility*: Display the spam folder and allow users to move emails between spam and inbox folders, with options to mark emails as "Not Spam" or "Spam" for user feedback.

### 9. Deployment (0.5 point)
- Deployed to a hosting service (e.g., Heroku, Render) with a public URL: `<public-url>` (replace with actual URL).
- MongoDB Atlas ensures data persistence.

### Bonus Features (1.0 points)
- **Custom Backend**: Built with Node.js/Express.js instead of Firebase, qualifying for 0.5 points.
- **AI Spam Detection**: Implemented a rule-based spam detection system, qualifying for an additional 0.5 points. Future enhancements could include machine learning models for improved accuracy.

## Frontend Responsibilities
The **Flutter frontend** must handle:
- **WYSIWYG Editor**: Use a package for rich text email composition.
- **Email Views**: Display basic (sender, subject, date) and detailed (body, attachments) email lists, including a spam folder.
- **Attachment Display**: Render images/PDFs using Cloudinary URLs.
- **Search UI**: Provide input fields for keywords and advanced filters (sender, recipient, date, attachments).
- **Label UI**: Create interfaces for managing and applying labels, including the "Spam" label.
- **Notifications**: Use `socket.io-client` to join WebSocket rooms (using user email) and display `newEmail` notifications, indicating spam status.
- **Auto Reply Settings**: Implement a settings screen for enabling/disabling auto-reply and editing messages.
- **Spam Management**: Allow users to view the spam folder, move emails to/from spam, and mark emails as "Not Spam" or "Spam".
- **Email Verification Check**: Prompt users to update and verify their email if `isEmailVerified: false` before email actions.
- **UI/UX**: Support dark/light modes and font preferences (1.0 point in rubric).

## Building and Running Instructions
1. **Verify MongoDB Atlas**: Ensure `MONGODB_URI` connects to a valid MongoDB instance.
2. **Configure Cloudinary**: Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
3. **Set Up Gmail**: Use a Gmail App Password for `GMAIL_USER` and `GMAIL_PASS`.
4. **Create Required Files**:
   - Ensure `spamDetection.js` exists in the `backend` directory to support spam detection.
5. **Run the Backend**:
   ```
   npm start
   ```
6. **Test APIs**: Use Postman or curl to test endpoints (e.g., `/api/auth/register`, `/api/email/send`, `/api/email/list/spam`).
7. **Test WebSocket**: Connect with `socket.io-client`, join a room with the user's email, and listen for `newEmail` events, checking for `isSpam` status.

## Sample Accounts for Testing
- **Account 1**:
  - Phone: `+1234567890`
  - Email: `user1@example.com`
  - Password: `P@ssw0rd123`
- **Account 2**:
  - Phone: `+0987654321`
  - Email: `user2@example.com`
  - Password: `P@ssw0rd123`
- These accounts have pre-loaded emails, labels (including "Spam"), and auto-reply settings for testing.

## Notes for Evaluation
- **Source Code**: Located in the `source` folder.
- **Cleaned Repository**: Excludes `node_modules` and other unnecessary files.
- **Public URL**: `<public-url>` (replace with actual URL after deployment).
- **Frontend Integration**: Ensure the Flutter frontend integrates with all APIs, WebSocket, and spam detection features.
- **Documentation**: Screenshots of teamwork and commits are in the `git` folder of the repository.
- **Submission**: Submitted as `id1_fullname1_id2_fullname2.zip` via the e-learning system.
- **Demo**: Refer to `demo.mp4` for a feature walkthrough, including spam detection.
- **Contact**: For issues, contact the team at `<team-contact-email>`.

## Team Information
- Team: <520H0341_NguyenThaiBao>
- GitHub Repository: <github-url>
- Submission Date: June 05, 2025

Thank you for evaluating our project!