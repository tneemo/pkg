Build a TypeScript REST API for a todo list app in the current directory (it is empty). Use Node.js 22.

Users sign up and log in, and each user only sees and changes their own todos.

API (JSON in and out):
- `GET /health` returns 200.
- `POST /auth/register` `{ "email", "password" }` creates an account and returns 201. Invalid email or a password shorter than 8 characters gets 400; an email that is already registered gets 409.
- `POST /auth/login` `{ "email", "password" }` returns 200 `{ "token": "<token>" }`; wrong credentials get 401.
- Every `/todos` route requires `Authorization: Bearer <token>` (otherwise 401):
  - `POST /todos` `{ "title" }` returns 201 with the todo `{ "id", "title", "done": false }`. A missing or empty title gets 400.
  - `GET /todos` returns 200 with an array of the caller's todos.
  - `PATCH /todos/:id` `{ "title"?, "done"? }` returns 200 with the updated todo.
  - `DELETE /todos/:id` returns 204.
  - A todo that does not exist or belongs to another user gets 404.

Configuration and running:
- Store data in SQLite at the path in the `DATABASE_PATH` environment variable, so data survives restarts.
- Read the token signing secret from the `JWT_SECRET` environment variable.
- Leave dependencies installed. `npm start` must start the API on the port in the `PORT` environment variable (default 3000) with no other command needed.
- Write automated tests. `npm test` must pass.

Do not ask me questions; make reasonable decisions. When you are done, briefly summarize what you built.
