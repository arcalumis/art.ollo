# ollo.art - System Architecture

## Tech Stack
- **Frontend:** React 19 + TypeScript + Tailwind CSS 4 + React Router
- **Backend:** Fastify 5 + Bun runtime + SQLite
- **Auth:** JWT (7-day expiry), SHA256 password hashing
- **Image Generation:** Replicate API (FLUX models)
- **Email:** Resend API

## Directory Structure

### Frontend (`/src`)
```
src/
├── pages/           # Route pages (AdminDashboard, AdminUsers, AdminProducts, etc.)
├── components/      # Reusable UI components
├── hooks/           # Custom hooks (useAdmin, useApi, useAuth)
├── contexts/        # React contexts (AuthContext)
├── types/           # TypeScript interfaces
└── config.ts        # API base URL configuration
```

### Backend (`/server`)
```
server/
├── index.ts         # Fastify server setup, CORS, static files
├── routes/          # API endpoints
│   ├── auth.ts      # /api/login, /api/register, /api/me
│   ├── admin.ts     # /api/admin/* (stats, users, products)
│   ├── user.ts      # /api/user/* (subscription, usage, credits, api-key)
│   ├── generate.ts  # /api/generate (image generation)
│   ├── history.ts   # /api/history (generation history)
│   ├── uploads.ts   # /api/uploads (reference images)
│   └── models.ts    # /api/models (available AI models)
├── services/        # Business logic
│   ├── usage.ts     # Usage tracking, subscriptions, credits
│   ├── encryption.ts # AES-256-GCM for API keys
│   ├── replicate.ts # Replicate API integration
│   ├── email.ts     # Resend email service
│   └── cleanup.ts   # Background cleanup job
├── db/
│   ├── index.ts     # Database initialization
│   └── schema.ts    # SQLite schema
└── middleware/
    └── auth.ts      # JWT authentication middleware
```

## Database (SQLite)
Location: `/data/generations.db` (WAL mode enabled)

**Tables:**
- `users` - username, password_hash, email, is_admin, is_active
- `subscription_products` - name, monthly_image_limit, monthly_cost_limit, bonus_credits, price
- `user_subscriptions` - user_id, product_id, starts_at, ends_at
- `user_api_keys` - user_id, provider, encrypted_api_key (AES-256-GCM)
- `user_credits` - user_id, credit_type, amount, reason
- `usage_monthly` - user_id, year_month, image_count, total_cost
- `generations` - prompt, model, image_path, width, height, cost, deleted_at
- `uploads` - user_id, filename, original_name, deleted_at

## Key Patterns

### Authentication
- JWT tokens in `Authorization: Bearer {token}` header
- `authMiddleware` validates token and sets `request.user`
- `adminMiddleware` checks `request.user.isAdmin`

### Admin Routes
All admin routes require both `authMiddleware` and `adminMiddleware`.
Pattern: `GET/POST/PATCH/DELETE /api/admin/{resource}`

### Frontend State
- `AuthContext` - Global auth state with `user`, `token`, `login()`, `logout()`
- Custom hooks (`useAdmin*.ts`) for API calls with token injection

## Environment Variables
See `.env.example` for all required variables:
- `REPLICATE_API_TOKEN` - For image generation
- `JWT_SECRET` - Token signing
- `ENCRYPTION_KEY` - API key encryption
- `RESEND_API_KEY` - Email sending
- `APP_URL` - Base URL for email links
