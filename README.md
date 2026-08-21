# Nuh-Uh Chat

A lightweight real-time chat app built with Node.js, Express, Socket.IO, bcrypt, and PostgreSQL.

## Database setup

User accounts are persisted in PostgreSQL. Passwords are **never stored in plaintext**; they are hashed with bcrypt before being written to the `users.password_hash` column.

Create a PostgreSQL database and set these environment variables before starting the server:

```env
DATABASE_URL=postgres://USERNAME:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL=false
PORT=10000
```

For hosted PostgreSQL services that require TLS, set `DATABASE_SSL=true`.

The server automatically creates the `users` and `banned_users` tables on startup. The SQL schema is also available in `database/schema.sql`.

## Run

```bash
npm install
npm start
```

Registering a new account now persists the username, bcrypt password hash, profile status, avatar, color, and moderation state across server restarts.
